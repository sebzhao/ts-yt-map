import { Client as PgClient } from 'pg';
import { migrate } from 'postgres-migrations';
import { DataSource, EntityManager, LessThan } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { validate } from 'class-validator';
import express from 'express';
import bodyParser from 'body-parser';

import ScrapedVideoData, { Video } from '../video';
import { Channel, ScrapedChannelData } from '../channel';
import { Recommendation } from '../recommendation';
import { ScrapedRecommendation } from '../scraper';
import { ServerConfig, LoggerInterface } from '../lib';
import { POSTGetUrlToCrawl, POSTRecommendation, POSTResetTimingForTesting, POSTClearDbForTesting } from '../endpoints/v1';

export interface ServerHandle {
  close: () => Promise<void>,
  pg: PgClient,
}

const asError = (e: unknown):Error => {
  if (e instanceof Error) {
    return e;
  }
  return new Error('Unknown error');
};

let countingRecommendationsSince = Date.now();
let recommendationsSaved = 0;

export const startServer = async (
  cfg: ServerConfig, log: LoggerInterface,
): Promise<ServerHandle> => {
  const pg = new PgClient({
    ...cfg.db,
    user: cfg.db.username,
  });

  try {
    await pg.connect();
  } catch (e) {
    log.error('Failed to connect to database', { error: e });
    throw e;
  }

  try {
    await migrate({ client: pg }, 'data/migrations');
  } catch (e) {
    log.error('Failed to migrate database', { error: e });
    throw e;
  }

  const ds = new DataSource({
    type: 'postgres',
    ...cfg.db,
    synchronize: false,
    entities: [Video, Channel, Recommendation],
    namingStrategy: new SnakeNamingStrategy(),
  });

  await ds.initialize();

  type URLResp = { ok: true, url: string } | { ok: false };

  const getVideoToCrawl = async (): Promise<URLResp> => {
    const resp = await ds.transaction(async (em: EntityManager): Promise<URLResp> => {
      const video = await em.createQueryBuilder()
        .select()
        .from(Video, 'video')
        .where("crawled = false AND crawl_attempt_count < 3 AND now() - latest_crawl_attempted_at > '10 minutes'::interval")
        .orderBy('random()')
        .getOne();

      if (video) {
        video.latestCrawlAttemptedAt = new Date();
        video.crawlAttemptCount += 1;
        await em.save(video);
        return { ok: true, url: video.url };
      }

      return { ok: true, url: cfg.seed_video };
    });

    return resp;
  };

  const saveChannelAndGetId = async (
    repo: EntityManager, channel: ScrapedChannelData,
  ): Promise<number> => {
    const currentChannel = await repo.findOneBy(Channel, {
      youtubeId: channel.youtubeId,
    });

    if (currentChannel) {
      return currentChannel.id;
    }

    const newChannel = new Channel(channel);
    const newChannelErrors = await validate(newChannel);
    if (newChannelErrors.length > 0) {
      log.error('Failed to save channel');
      log.error(newChannelErrors);
      throw new Error('Failed to save channel');
    }
    const savedChannel = await repo.save(newChannel);
    return savedChannel.id;
  };

  const saveVideo = async (
    em: EntityManager, video: ScrapedVideoData,
  ): Promise<Video> => {
    if (!video.channel) {
      throw new Error('Video must have a channel');
    }

    const channelId = await saveChannelAndGetId(em, video.channel);

    const videoEntity = new Video(video);
    videoEntity.channelId = channelId;
    const videoErrors = await validate(videoEntity);
    if (videoErrors.length > 0) {
      const msg = `Invalid video: ${JSON.stringify(videoErrors)}`;
      log.error(msg, { video });
      throw new Error(msg);
    }

    const saved = await em.findOneBy(Video, { url: videoEntity.url });

    if (saved) {
      return saved;
    }

    const newVideo = await em.save(videoEntity);
    return newVideo;
  };

  const app = express();

  app.use(bodyParser.json());
  app.use((req, res, next) => {
    log.debug('Authorizing request...');
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (req.headers['x-password'] !== cfg.password) {
      log.error(`Invalid password from ${ip}, got ${req.headers['x-password']} instead of ${cfg.password}`);
      res.status(401).send('Unauthorized');
      return;
    }
    log.debug('Authorized');

    next();
  });

  app.post(POSTGetUrlToCrawl, async (req, res) => {
    log.debug('Getting video to crawl...');
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    req.setTimeout(1000 * 5);
    const u = await getVideoToCrawl();

    if (u.ok) {
      log.info(`Sent video to crawl ${u.url} to ${ip}`);
      res.status(200).json(u);
    } else {
      log.info(`No video to crawl for ${ip}`);
      res.status(504).json(u);
    }
  });

  app.post(POSTResetTimingForTesting, (req, res) => {
    countingRecommendationsSince = Date.now();
    recommendationsSaved = 0;
    res.status(200).json({ ok: true });
  });

  app.post(POSTRecommendation, async (req, res) => {
    const data = new ScrapedRecommendation(req.body.from, req.body.to);
    const errors = await validate(data);
    if (errors.length > 0) {
      log.error('Invalid recommendations', { errors });
      res.status(400).json({ OK: false, count: 0 });
      throw new Error('Error in recommendations data.');
    }

    log.info('Received recommendations to save.');

    try {
      const videoRepo = ds.getRepository(Video);
      const from = await videoRepo.findOneBy({ url: data.from.url });

      if (from) {
        const recommendations = await ds.getRepository(Recommendation).findBy({
          fromId: from.id,
        });

        if (recommendations.length >= 10) {
          log.info('Recommendations already exist.');
          res.status(201).json({ ok: true, count: 0 });
          return;
        }
      }

      await ds.manager.transaction(async (em: EntityManager) => {
        const from = await saveVideo(em, data.from);

        from.crawled = true;

        const saves = Object.entries(data.to)
          .map(async ([rank, video]): Promise<Recommendation> => {
          // eslint-disable-next-line no-await-in-loop
            const to = await saveVideo(em, video);

            log.info(`Saving recommendation from ${from.id} to ${to.id}`);

            const recommendation = new Recommendation();
            recommendation.fromId = from.id;
            recommendation.toId = to.id;
            recommendation.createdAt = new Date();
            recommendation.updatedAt = new Date();
            recommendation.rank = +rank;
            try {
              return await em.save(recommendation);
            } catch (e) {
              log.error(`Failed to save recommendation from ${from.id} to ${to.id}: ${asError(e).message}`, { e });
              throw e;
            }
          });

        await Promise.all(saves);
        await em.save(from);

        recommendationsSaved += data.to.length;
        const elapsed = (Date.now() - countingRecommendationsSince) / 1000 / 60;

        if (elapsed > 0) {
          const recommendationsPerMinute = Math.round(recommendationsSaved / elapsed);
          log.info(`Saved recommendations per minute: ${recommendationsPerMinute}`);

          // resetting the average every 10 minutes
          if (elapsed > 10) {
            countingRecommendationsSince = Date.now();
            recommendationsSaved = 0;
          }
        }

        res.json({ ok: true, count: data.to.length });
      });
    } catch (error) {
      const { message } = asError(error);
      log.error(`Could not save recommendations: ${message}`, { error });
      log.error(error);
      res.status(500).send({ ok: false, message });
    }
  });

  const server = app.listen(
    // eslint-disable-next-line no-console
    cfg.port, '0.0.0.0', () => log.info(`Listening on port ${cfg.port}`, '0.0.0.0'),
  );

  app.post(POSTResetTimingForTesting, async (req, res) => {
    res.status(200).json({ ok: true });
  });

  app.post(POSTClearDbForTesting, async (req, res) => {
    const queries = [
      'truncate recommendation cascade',
      'truncate video cascade',
      'truncate channel cascade',
    ];

    queries.forEach(async (query) => {
      await ds.query(query);
    });

    res.json({ queries });
  });

  return {
    pg,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close(
          (err) => {
            if (err) {
              reject(err);
            } else {
              resolve(null);
            }
          },
        );
      });

      await pg.end();
    },
  };
};

export default startServer;

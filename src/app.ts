import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { createTokens, type Tokens } from './auth/tokens.ts';
import { registerClaimRoutes } from './claims/routes.ts';
import { registerCouponRoutes } from './coupons/routes.ts';
import { registerDocs } from './docs.ts';
import { errorHandler, notFoundHandler } from './lib/problem.ts';
import { createCache, type Cache, type Redis } from './lib/redis.ts';

export interface AppContext {
  config: Config;
  db: Db;
  redis: Redis;
  logger: Logger;
  tokens: Tokens;
  cache: Cache;
}

export interface AppDeps {
  config: Config;
  db: Db;
  redis: Redis;
  logger: Logger;
}

export function createApp(deps: AppDeps): { app: Express; ctx: AppContext } {
  const { config, db, redis, logger } = deps;
  const ctx: AppContext = { config, db, redis, logger, tokens: createTokens(config), cache: createCache(redis, logger) };

  const app = express();
  app.set('trust proxy', config.TRUST_PROXY);
  app.disable('x-powered-by');
  // Defaults everywhere. Swagger UI needs inline script/style; registerDocs relaxes the CSP
  // for /docs alone rather than weakening it for the whole API.
  app.use(helmet());
  app.use(
    pinoHttp({
      logger,
      autoLogging: config.NODE_ENV !== 'test',
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && incoming.length <= 128 ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
    }),
  );
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', async (_req, res) => {
    const probe = (p: Promise<unknown>) =>
      Promise.race([
        p,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('timeout')), 1500).unref();
        }),
      ]).then(
        () => 'ok' as const,
        () => 'fail' as const,
      );
    const [postgres, redisStatus] = await Promise.all([probe(sql`select 1`.execute(db)), probe(redis.ping())]);
    const status = postgres === 'fail' ? 'fail' : redisStatus === 'fail' ? 'degraded' : 'ok';
    res.status(postgres === 'fail' ? 503 : 200).json({ status, checks: { postgres, redis: redisStatus } });
  });

  registerAuthRoutes(app, ctx);
  registerCouponRoutes(app, ctx);
  registerClaimRoutes(app, ctx);
  registerDocs(app);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return { app, ctx };
}

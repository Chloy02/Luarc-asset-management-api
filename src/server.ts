import pino from 'pino';
import { createApp } from './app.ts';
import { loadConfig, type Config } from './config.ts';
import { createDb } from './db/index.ts';
import { createRedis } from './lib/redis.ts';

function mustLoadConfig(): Config {
  try {
    return loadConfig();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

const config = mustLoadConfig();
const logger = pino({ level: config.LOG_LEVEL, redact: ['req.headers.authorization'] });
const db = createDb(config.DATABASE_URL, {
  poolMax: config.PG_POOL_MAX,
  statementTimeoutMs: config.PG_STATEMENT_TIMEOUT_MS,
  lockTimeoutMs: config.PG_LOCK_TIMEOUT_MS,
  onError: (err) => logger.warn({ err: err.message }, 'idle postgres client error'),
});
const redis = createRedis(config.REDIS_URL, logger);

// Not awaited on purpose: the API must start even if Redis is down. Until it reconnects,
// rate limiting and caching fail open and /health reports "degraded".
redis.connect().catch((err: Error) => logger.error({ err: err.message }, 'redis unavailable at startup'));

const { app } = createApp({ config, db, redis, logger });
const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'listening'));

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  const force = setTimeout(() => {
    logger.error('shutdown timed out; forcing exit');
    process.exit(1);
  }, 10_000);
  force.unref();
  server.close(() => {
    void db.destroy().finally(() => {
      redis.destroy();
      process.exit(0);
    });
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

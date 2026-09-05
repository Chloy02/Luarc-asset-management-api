import type { RequestHandler } from 'express';
import type { Logger } from 'pino';
import { createClient } from 'redis';
import { HttpProblem } from './problem.ts';

export type Redis = ReturnType<typeof createClient>;

/** Returns an unconnected client. Callers decide whether to await connect(). */
export function createRedis(url: string, logger: Logger): Redis {
  const client = createClient({
    url,
    // Reject commands instantly while disconnected instead of queueing them forever.
    // This is what lets the rate limiter and cache fail open in milliseconds.
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 2000,
      reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 5000),
    },
  });
  // Without an error listener node-redis throws on the process, taking the API down with Redis.
  client.on('error', (err: Error) => logger.warn({ err: err.message }, 'redis error'));
  // ReturnType<typeof createClient> resolves createClient's defaulted generics to their
  // constraints (RedisModules, not {}), which the concrete client this call produces doesn't
  // structurally satisfy. Same object, narrower assertion; see task-3-report.md.
  return client as Redis;
}

export interface RateLimitOptions {
  max: number;
  windowSeconds: number;
  prefix: string;
}

/** Fixed-window limiter keyed by client IP. Fails open if Redis is unavailable. */
export function rateLimit(redis: Redis, logger: Logger, opts: RateLimitOptions): RequestHandler {
  return async (req, res, next) => {
    const key = `${opts.prefix}:${req.ip ?? 'unknown'}`;
    let count: number;
    let ttl = opts.windowSeconds;
    try {
      count = await redis.incr(key);
      // ponytail: INCR then EXPIRE is two round trips and not atomic; a crash between them
      // leaves a key with no TTL. A 5-line Lua script fixes both if it ever matters.
      if (count === 1) await redis.expire(key, opts.windowSeconds);
      if (count > opts.max) ttl = Math.max(await redis.ttl(key), 1);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'rate limiter unavailable; failing open');
      return next();
    }
    if (count > opts.max) {
      res.setHeader('Retry-After', String(ttl));
      return next(
        new HttpProblem(429, 'rate-limited', 'Too many requests', `Limit of ${opts.max} requests per ${opts.windowSeconds}s exceeded.`, {
          retry_after: ttl,
        }),
      );
    }
    next();
  };
}

export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

/** Thin fail-open wrapper: a Redis outage degrades to "no cache", never to an error. */
export function createCache(redis: Redis, logger: Logger): Cache {
  const failOpen = (op: string) => (err: unknown) => {
    logger.warn({ err: (err as Error).message, op }, 'cache unavailable; failing open');
    return null;
  };
  return {
    get: (key) => redis.get(key).catch(failOpen('get')),
    set: async (key, value, ttlSeconds) => {
      await redis.set(key, value, { EX: ttlSeconds }).catch(failOpen('set'));
    },
    del: async (key) => {
      await redis.del(key).catch(failOpen('del'));
    },
  };
}

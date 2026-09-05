import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1),
  PG_POOL_MAX: z.coerce.number().int().min(1).default(10),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_ISSUER: z.string().min(1).default('luarc-asset-api'),
  JWT_AUDIENCE: z.string().min(1).default('authenticated'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(30 * 24 * 3600),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_AUTH_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
  STATS_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).default(5),
  TRUST_PROXY: z.stringbool().default(false),
});

export type Config = z.infer<typeof schema>;

/** Validate environment at startup so a bad deploy fails fast with a readable message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}

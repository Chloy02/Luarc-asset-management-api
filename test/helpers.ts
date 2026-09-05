import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'kysely';
import pino from 'pino';
import { createApp, type AppContext } from '../src/app.ts';
import { hashPassword } from '../src/auth/passwords.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { createDb, type Db } from '../src/db/index.ts';
import { migrateToLatest } from '../src/db/migrate.ts';
import { createRedis, type Redis } from '../src/lib/redis.ts';

export interface TestContext {
  base: string;
  config: Config;
  db: Db;
  redis: Redis;
  ctx: AppContext;
  close(): Promise<void>;
}

export const TEST_PASSWORD = 'correct horse battery staple';

/** Boot the real app on an ephemeral port against the test database, migrated and truncated. */
export async function bootTestApp(overrides: Partial<Config> = {}, opts: { awaitRedis?: boolean } = {}): Promise<TestContext> {
  const config: Config = { ...loadConfig(), ...overrides };
  const logger = pino({ level: 'silent' });
  const db = createDb(config.DATABASE_URL, {
    poolMax: config.PG_POOL_MAX,
    statementTimeoutMs: config.PG_STATEMENT_TIMEOUT_MS,
    lockTimeoutMs: config.PG_LOCK_TIMEOUT_MS,
    // Tests terminate idle backends on purpose; the pool discards them and we stay quiet.
    onError: () => {},
  });
  const redis = createRedis(config.REDIS_URL, logger);
  if (opts.awaitRedis === false) {
    // Mirrors server.ts: start without Redis and let the client retry in the background.
    redis.connect().catch(() => {});
  } else {
    await redis.connect();
  }
  await migrateToLatest(db);
  const { app, ctx } = createApp({ config, db, redis, logger });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const t: TestContext = {
    base: `http://127.0.0.1:${port}`,
    config,
    db,
    redis,
    ctx,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
      await db.destroy();
      try {
        redis.destroy();
      } catch {
        // never connected
      }
    },
  };
  await resetState(t);
  return t;
}

export async function resetState(t: TestContext): Promise<void> {
  await sql`TRUNCATE claims, refresh_tokens, coupons, users RESTART IDENTITY CASCADE`.execute(t.db);
  await t.redis.flushDb().catch(() => {
    // Redis intentionally unreachable in the fail-open test.
  });
}

let sharedHash: Promise<string> | undefined;

export interface TestUser {
  id: string;
  email: string;
  token: string;
}

/** Insert a user directly and mint an access token. Bypasses HTTP so fixtures are fast. */
export async function createUser(t: TestContext, email = `u-${randomUUID()}@test.local`): Promise<TestUser> {
  sharedHash ??= hashPassword(TEST_PASSWORD);
  const user = await t.db
    .insertInto('users')
    .values({ email, password_hash: await sharedHash })
    .returning(['id', 'email'])
    .executeTakeFirstOrThrow();
  return { ...user, token: await t.ctx.tokens.signAccess(user) };
}

export async function createUsers(t: TestContext, n: number): Promise<TestUser[]> {
  sharedHash ??= hashPassword(TEST_PASSWORD);
  const hash = await sharedHash;
  const batch = randomUUID().slice(0, 8);
  const rows = await t.db
    .insertInto('users')
    .values(Array.from({ length: n }, (_, i) => ({ email: `u-${batch}-${i}@test.local`, password_hash: hash })))
    .returning(['id', 'email'])
    .execute();
  return Promise.all(rows.map(async (u) => ({ ...u, token: await t.ctx.tokens.signAccess(u) })));
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  // Response shapes vary per endpoint; tests assert on them explicitly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export async function api(
  t: TestContext,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(t.base + path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, headers: res.headers, body };
}

/** Create a coupon through the API as the given user. Defaults are valid; override what the test needs. */
export async function createCoupon(t: TestContext, token: string, overrides: Record<string, unknown> = {}) {
  const res = await api(t, 'POST', '/coupons', {
    token,
    body: { code: `C-${randomUUID().slice(0, 8).toUpperCase()}`, title: 'Test coupon', total_quantity: 10, ...overrides },
  });
  if (res.status !== 201) throw new Error(`createCoupon failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

# Asset Management API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the authenticated coupon/voucher API described in the spec, provably consistent under concurrent claims and edits, with the read endpoints, Redis extras, tests, Docker, CI, and README needed for the Luarc take-home.

**Architecture:** Express 5 app over Postgres 16 via Kysely. Consistency lives in the database: a two-statement claim transaction (insert claim, conditional UPDATE) backed by UNIQUE and CHECK constraints, and version-based optimistic locking for edits. Redis handles only auth rate limiting and a short-TTL stats cache, both fail-open. Node 24 runs TypeScript natively; tests use `node:test` and `fetch` against a real Postgres and Redis.

**Tech Stack:** Node 24 (native TS, `--env-file`, `node:test`), Express 5.2, Kysely 0.29, pg 8, zod 4, jose 6 (HS256), node-redis 6, pino 10 + pino-http 11, helmet 8, swagger-ui-express 5, TypeScript 5.9 (typecheck only), Docker Compose, GitHub Actions, k6 (via Docker image).

**Spec:** `docs/superpowers/specs/2026-09-06-asset-management-api-design.md`

## Global Constraints

- Node `>=24`. TypeScript is executed by Node directly; `tsc --noEmit` is type checking only. All relative imports use the `.ts` extension. No enums, no parameter properties, no namespaces with runtime code (`erasableSyntaxOnly`).
- Exactly 10 runtime dependencies: express, kysely, pg, jose, zod, redis, pino, pino-http, helmet, swagger-ui-express. Dev: typescript, @types/node, @types/express, @types/pg, @types/swagger-ui-express. Do not add others.
- Every constraint in the migration is named explicitly, exactly as listed in Task 2. `lib/problem.ts` maps pg errors by those names and is the only file that knows pg error codes.
- Every SQL statement touching `coupons` or `claims` lives in `src/coupons/service.ts`.
- Error bodies are RFC 9457 problem details with `Content-Type: application/problem+json`, `type: "/problems/<slug>"`, and a `request_id`.
- Redis is never on the claim or update path. Rate limiter and cache fail open with a warn log.
- `claimed_count` is changed only by the claim transaction. `version` is changed only by PATCH.
- Tests run against `postgres://luarc:luarc@localhost:5434/luarc_test` and `redis://localhost:6380/1` (Docker Compose services) with `--test-concurrency=1`. Tests never mock the database or Redis.
- Commit after every task with a Conventional Commits message. Work on branch `feat/asset-api` created in Task 1.
- Passwords: scrypt N=32768, r=8, p=3, 16-byte salt, 64-byte key, stored as `scrypt$32768$8$3$<salt_b64>$<hash_b64>`.
- Access token TTL default 900s; refresh TTL default 2592000s; auth rate limit default 10 per 60s per IP; stats cache TTL default 5s.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `.gitignore`, `.dockerignore`, `.env.example`, `.env.test` | Tooling and configuration |
| `docker-compose.yml`, `docker/init-test-db.sql`, `Dockerfile` | Local infra and container image |
| `.github/workflows/ci.yml` | CI |
| `src/config.ts` | zod-validated environment → `Config` |
| `src/server.ts` | Bootstrap and graceful shutdown |
| `src/app.ts` | `createApp(deps)`: middleware, health, docs, route registration, error handling |
| `src/express.d.ts` | `req.user` type augmentation |
| `src/db/index.ts` | `Database` table types, `createDb()` |
| `src/db/migrations/0001_init.ts` | Schema |
| `src/db/migrate.ts` | `migrateToLatest(db)` + CLI |
| `src/db/seed.ts` | `seed(db)` + CLI |
| `src/lib/problem.ts` | `HttpProblem`, `notFound()`, `mapPgError()`, `notFoundHandler`, `errorHandler()` |
| `src/lib/validate.ts` | `parse()`, `parseId()` |
| `src/lib/pagination.ts` | `pageQuery`, cursors, `page()` |
| `src/lib/redis.ts` | `createRedis()`, `rateLimit()`, `createCache()` |
| `src/auth/passwords.ts` | scrypt hash/verify |
| `src/auth/tokens.ts` | `createTokens(config)` |
| `src/auth/middleware.ts` | `requireAuth(tokens)` |
| `src/auth/routes.ts` | `/auth/*`, `/me`, `issueTokenPair()` |
| `src/coupons/service.ts` | All coupon and claim SQL |
| `src/coupons/routes.ts` | `/coupons/*` |
| `src/claims/routes.ts` | `/me/claims` |
| `openapi.yaml` | API contract |
| `test/helpers.ts` | Boot app, reset state, create users/coupons, `api()` |
| `test/*.test.ts` | One file per area |
| `load/prepare.ts`, `load/claim-race.js` | k6 fixtures and script |
| `README.md` | Reviewer-facing write-up |

---

### Task 1: Project scaffold, config, and local infrastructure

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.dockerignore`, `.env.example`, `.env.test`, `docker-compose.yml`, `docker/init-test-db.sql`, `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): Config` (throws `Error` with a readable message on invalid env), `type Config`.

- [ ] **Step 1: Create the branch and package.json**

```bash
git checkout -b feat/asset-api
```

Create `package.json`:

```json
{
  "name": "luarc-asset-management-api",
  "version": "1.0.0",
  "private": true,
  "description": "Consistency-first coupon/voucher API: authenticated claims that stay correct under concurrency.",
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "dev": "node --watch --env-file=.env src/server.ts",
    "start": "node src/server.ts",
    "migrate": "node --env-file=.env src/db/migrate.ts",
    "seed": "node --env-file=.env src/db/seed.ts",
    "typecheck": "tsc --noEmit",
    "test": "node --env-file=.env.test --test --test-concurrency=1 'test/**/*.test.ts'",
    "load:prepare": "node --env-file=.env load/prepare.ts",
    "load": "docker run --rm --network host -v \"$PWD/load:/load\" -e BASE_URL=http://localhost:3000 grafana/k6 run /load/claim-race.js"
  }
}
```

Install dependencies (this writes the `dependencies`/`devDependencies` blocks and the lockfile):

```bash
npm install express@^5.2 kysely@^0.29 pg@^8.23 jose@^6.2 zod@^4.5 redis@^6.2 pino@^10.3 pino-http@^11 helmet@^8 swagger-ui-express@^5
npm install -D typescript@^5.9 @types/node@^24 @types/express@^5 @types/pg@^8 @types/swagger-ui-express@^4
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "es2024",
    "lib": ["es2024"],
    "module": "nodenext",
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true
  },
  "include": ["src", "test", "load/prepare.ts"]
}
```

- [ ] **Step 3: Create ignore files and env files**

`.gitignore`:

```
node_modules/
.env
load/fixtures.json
*.log
```

`.dockerignore`:

```
node_modules
.git
test
load
docs
.env
.env.test
.github
```

`.env.example`:

```
PORT=3000
NODE_ENV=development
LOG_LEVEL=info
DATABASE_URL=postgres://luarc:luarc@localhost:5434/luarc
PG_POOL_MAX=10
REDIS_URL=redis://localhost:6380/0
# Must be at least 32 characters. Docker Compose reads this same value from .env so
# tokens minted by load/prepare.ts are accepted by the containerised API.
JWT_SECRET=dev-only-secret-change-me-before-any-real-deployment
JWT_ISSUER=luarc-asset-api
JWT_AUDIENCE=authenticated
ACCESS_TOKEN_TTL_SECONDS=900
REFRESH_TOKEN_TTL_SECONDS=2592000
RATE_LIMIT_AUTH_MAX=10
RATE_LIMIT_AUTH_WINDOW_SECONDS=60
STATS_CACHE_TTL_SECONDS=5
TRUST_PROXY=false
```

`.env.test` (committed; nothing secret in it):

```
NODE_ENV=test
LOG_LEVEL=silent
DATABASE_URL=postgres://luarc:luarc@localhost:5434/luarc_test
PG_POOL_MAX=20
REDIS_URL=redis://localhost:6380/1
JWT_SECRET=test-secret-test-secret-test-secret-1234
JWT_ISSUER=luarc-asset-api
JWT_AUDIENCE=authenticated
ACCESS_TOKEN_TTL_SECONDS=900
REFRESH_TOKEN_TTL_SECONDS=2592000
RATE_LIMIT_AUTH_MAX=100000
RATE_LIMIT_AUTH_WINDOW_SECONDS=60
STATS_CACHE_TTL_SECONDS=5
TRUST_PROXY=false
```

Then `cp .env.example .env`.

- [ ] **Step 4: Create docker-compose.yml with Postgres and Redis (the api service is added in Task 13)**

`docker/init-test-db.sql`:

```sql
CREATE DATABASE luarc_test;
```

`docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: luarc
      POSTGRES_PASSWORD: luarc
      POSTGRES_DB: luarc
    ports:
      - "5434:5432"
    volumes:
      - ./docker/init-test-db.sql:/docker-entrypoint-initdb.d/01-test-db.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U luarc -d luarc"]
      interval: 2s
      timeout: 3s
      retries: 15

  redis:
    image: redis:7-alpine
    ports:
      - "6380:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 3s
      retries: 15
```

Start them and confirm both databases exist:

```bash
docker-compose up -d postgres redis
sleep 5
docker-compose exec -T postgres psql -U luarc -d postgres -Atc "select datname from pg_database where datname like 'luarc%'"
```

Expected output: two lines, `luarc` and `luarc_test`.

- [ ] **Step 5: Write the failing config test**

`test/config.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

const minimal = {
  DATABASE_URL: 'postgres://u:p@localhost:5434/db',
  REDIS_URL: 'redis://localhost:6380/0',
  JWT_SECRET: 'x'.repeat(32),
};

test('loadConfig applies documented defaults', () => {
  const cfg = loadConfig(minimal);
  assert.equal(cfg.PORT, 3000);
  assert.equal(cfg.NODE_ENV, 'development');
  assert.equal(cfg.PG_POOL_MAX, 10);
  assert.equal(cfg.JWT_ISSUER, 'luarc-asset-api');
  assert.equal(cfg.JWT_AUDIENCE, 'authenticated');
  assert.equal(cfg.ACCESS_TOKEN_TTL_SECONDS, 900);
  assert.equal(cfg.REFRESH_TOKEN_TTL_SECONDS, 2592000);
  assert.equal(cfg.RATE_LIMIT_AUTH_MAX, 10);
  assert.equal(cfg.RATE_LIMIT_AUTH_WINDOW_SECONDS, 60);
  assert.equal(cfg.STATS_CACHE_TTL_SECONDS, 5);
  assert.equal(cfg.TRUST_PROXY, false);
});

test('loadConfig coerces numbers and booleans from strings', () => {
  const cfg = loadConfig({ ...minimal, PORT: '8080', TRUST_PROXY: 'true', RATE_LIMIT_AUTH_MAX: '3' });
  assert.equal(cfg.PORT, 8080);
  assert.equal(cfg.TRUST_PROXY, true);
  assert.equal(cfg.RATE_LIMIT_AUTH_MAX, 3);
});

test('loadConfig rejects a short JWT_SECRET with a readable message', () => {
  assert.throws(() => loadConfig({ ...minimal, JWT_SECRET: 'short' }), /JWT_SECRET/);
});

test('loadConfig rejects a missing DATABASE_URL', () => {
  const { DATABASE_URL: _omit, ...rest } = minimal;
  assert.throws(() => loadConfig(rest), /DATABASE_URL/);
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `node --test test/config.test.ts`
Expected: FAIL, module `../src/config.ts` not found.

- [ ] **Step 7: Implement src/config.ts**

```ts
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
```

- [ ] **Step 8: Run the tests and typecheck**

Run: `node --test test/config.test.ts && npm run typecheck`
Expected: 4 passing, typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore .dockerignore .env.example .env.test docker-compose.yml docker/init-test-db.sql src/config.ts test/config.test.ts
git commit -m "chore: scaffold project, validated config, local postgres and redis"
```

---

### Task 2: Database types, migration, migrate and seed scripts

**Files:**
- Create: `src/db/index.ts`, `src/db/migrations/0001_init.ts`, `src/db/migrate.ts`, `src/db/seed.ts`, `src/auth/passwords.ts`
- Test: `test/db.test.ts`

**Interfaces:**
- Consumes: `loadConfig()` from Task 1.
- Produces: `interface Database`, `type Db = Kysely<Database>`, `type CouponStatus = 'active' | 'disabled'`, `createDb(url: string, poolMax: number): Db`, `migrateToLatest(db: Db): Promise<void>`, `seed(db: Db): Promise<void>`, `hashPassword(pw: string): Promise<string>`, `verifyPassword(pw: string, stored: string): Promise<boolean>`.
- Constraint names (used by `mapPgError` in Task 3): `users_email_key`, `refresh_tokens_token_hash_key`, `refresh_tokens_user_id_fkey`, `coupons_code_key`, `coupons_created_by_fkey`, `coupons_status_check`, `coupons_total_quantity_positive`, `coupons_claimed_within_total`, `claims_coupon_id_user_id_key`, `claims_coupon_id_fkey`, `claims_user_id_fkey`.

- [ ] **Step 1: Write the failing database test**

`test/db.test.ts`:

```ts
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { loadConfig } from '../src/config.ts';
import { createDb, type Db } from '../src/db/index.ts';
import { migrateToLatest } from '../src/db/migrate.ts';
import { seed } from '../src/db/seed.ts';

let db: Db;

before(async () => {
  const cfg = loadConfig();
  db = createDb(cfg.DATABASE_URL, cfg.PG_POOL_MAX);
  await migrateToLatest(db);
  await sql`TRUNCATE claims, refresh_tokens, coupons, users RESTART IDENTITY CASCADE`.execute(db);
});

after(async () => {
  await db.destroy();
});

async function insertUser(email: string) {
  return db
    .insertInto('users')
    .values({ email, password_hash: 'scrypt$32768$8$3$AAAA$BBBB' })
    .returning('id')
    .executeTakeFirstOrThrow();
}

test('migration is idempotent', async () => {
  await migrateToLatest(db);
  const tables = await sql<{ table_name: string }>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('users','refresh_tokens','coupons','claims')
    ORDER BY table_name`.execute(db);
  assert.deepEqual(tables.rows.map((r) => r.table_name), ['claims', 'coupons', 'refresh_tokens', 'users']);
});

test('CHECK constraint refuses claimed_count above total_quantity', async () => {
  const user = await insertUser('check@test.local');
  await assert.rejects(
    db
      .insertInto('coupons')
      .values({ code: 'CHECK-1', title: 'x', total_quantity: 1, claimed_count: 2, created_by: user.id })
      .execute(),
    (err: { code?: string; constraint?: string }) =>
      err.code === '23514' && err.constraint === 'coupons_claimed_within_total',
  );
});

test('UNIQUE constraint refuses a second claim by the same user', async () => {
  const user = await insertUser('unique@test.local');
  const coupon = await db
    .insertInto('coupons')
    .values({ code: 'UNIQ-1', title: 'x', total_quantity: 5, created_by: user.id })
    .returning('id')
    .executeTakeFirstOrThrow();
  const first = await db
    .insertInto('claims')
    .values({ coupon_id: coupon.id, user_id: user.id })
    .returning('id')
    .executeTakeFirstOrThrow();
  assert.equal(typeof first.id, 'number', 'bigint ids must be parsed to JS numbers');
  await assert.rejects(
    db.insertInto('claims').values({ coupon_id: coupon.id, user_id: user.id }).execute(),
    (err: { code?: string; constraint?: string }) =>
      err.code === '23505' && err.constraint === 'claims_coupon_id_user_id_key',
  );
});

test('seed is idempotent and creates the demo data', async () => {
  await seed(db);
  await seed(db);
  const users = await db.selectFrom('users').select('email').where('email', '=', 'demo@luarc.test').execute();
  assert.equal(users.length, 1);
  const coupons = await db.selectFrom('coupons').select(['code', 'status']).orderBy('code').execute();
  assert.deepEqual(
    coupons.map((c) => c.code),
    ['BIG-10000', 'DISABLED-1', 'EXPIRED-1', 'RACE-50', 'WELCOME-100'],
  );
  assert.equal(coupons.find((c) => c.code === 'DISABLED-1')?.status, 'disabled');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --env-file=.env.test --test test/db.test.ts`
Expected: FAIL, `../src/db/index.ts` not found.

- [ ] **Step 3: Create src/db/index.ts**

```ts
import { Kysely, PostgresDialect, type Generated } from 'kysely';
import pg from 'pg';

// pg returns int8 (bigint, and SUM/COUNT results) as strings to avoid precision loss.
// Our ids and counters fit comfortably in 2^53, so parse them to numbers once, globally.
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v));

export type CouponStatus = 'active' | 'disabled';

export interface UsersTable {
  id: Generated<string>;
  email: string;
  password_hash: string;
  created_at: Generated<Date>;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Generated<Date>;
}

export interface CouponsTable {
  id: Generated<string>;
  code: string;
  title: string;
  description: string | null;
  status: Generated<CouponStatus>;
  total_quantity: number;
  claimed_count: Generated<number>;
  expires_at: Date | null;
  version: Generated<number>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ClaimsTable {
  id: Generated<number>;
  coupon_id: string;
  user_id: string;
  claimed_at: Generated<Date>;
}

export interface Database {
  users: UsersTable;
  refresh_tokens: RefreshTokensTable;
  coupons: CouponsTable;
  claims: ClaimsTable;
}

export type Db = Kysely<Database>;

export function createDb(connectionString: string, poolMax: number): Db {
  const pool = new pg.Pool({ connectionString, max: poolMax, connectionTimeoutMillis: 5000 });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
```

- [ ] **Step 4: Create the migration src/db/migrations/0001_init.ts**

```ts
import { type Kysely, sql } from 'kysely';

// Every constraint is named explicitly. src/lib/problem.ts maps pg errors to HTTP
// problems by these names, so renaming one here means updating that map.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('users')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('email', 'text', (c) => c.notNull())
    .addColumn('password_hash', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('users_email_key', ['email'])
    .execute();

  await db.schema
    .createTable('refresh_tokens')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (c) => c.notNull())
    .addColumn('token_hash', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('revoked_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('refresh_tokens_token_hash_key', ['token_hash'])
    .addForeignKeyConstraint('refresh_tokens_user_id_fkey', ['user_id'], 'users', ['id'], (cb) =>
      cb.onDelete('cascade'),
    )
    .execute();
  await db.schema.createIndex('refresh_tokens_user_id_idx').on('refresh_tokens').column('user_id').execute();

  await db.schema
    .createTable('coupons')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('code', 'text', (c) => c.notNull())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('description', 'text')
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('active'))
    .addColumn('total_quantity', 'integer', (c) => c.notNull())
    .addColumn('claimed_count', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('expires_at', 'timestamptz')
    .addColumn('version', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('created_by', 'uuid', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('coupons_code_key', ['code'])
    .addForeignKeyConstraint('coupons_created_by_fkey', ['created_by'], 'users', ['id'])
    .addCheckConstraint('coupons_status_check', sql`status IN ('active', 'disabled')`)
    .addCheckConstraint('coupons_total_quantity_positive', sql`total_quantity > 0`)
    // The oversell backstop: even a buggy application cannot push the counter past total.
    .addCheckConstraint('coupons_claimed_within_total', sql`claimed_count >= 0 AND claimed_count <= total_quantity`)
    .execute();
  // Pool listing filters by status and pages by code.
  await db.schema.createIndex('coupons_status_code_idx').on('coupons').columns(['status', 'code']).execute();

  await db.schema
    .createTable('claims')
    // bigint identity: monotonic, exact, and the keyset cursor for /me/claims.
    .addColumn('id', 'bigint', (c) => c.primaryKey().generatedAlwaysAsIdentity())
    .addColumn('coupon_id', 'uuid', (c) => c.notNull())
    .addColumn('user_id', 'uuid', (c) => c.notNull())
    .addColumn('claimed_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    // One claim per user per coupon, enforced across concurrent transactions by the unique index.
    .addUniqueConstraint('claims_coupon_id_user_id_key', ['coupon_id', 'user_id'])
    .addForeignKeyConstraint('claims_coupon_id_fkey', ['coupon_id'], 'coupons', ['id'])
    .addForeignKeyConstraint('claims_user_id_fkey', ['user_id'], 'users', ['id'])
    .execute();
  // History: WHERE user_id = $1 AND id < $cursor ORDER BY id DESC — one backward index scan.
  await db.schema.createIndex('claims_user_id_id_idx').on('claims').columns(['user_id', 'id']).execute();
  await db.schema.createIndex('claims_coupon_id_idx').on('claims').column('coupon_id').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('claims').execute();
  await db.schema.dropTable('coupons').execute();
  await db.schema.dropTable('refresh_tokens').execute();
  await db.schema.dropTable('users').execute();
}
```

- [ ] **Step 5: Create src/db/migrate.ts**

```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FileMigrationProvider, Migrator } from 'kysely';
import { loadConfig } from '../config.ts';
import { createDb, type Db } from './index.ts';

export async function migrateToLatest(db: Db): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(import.meta.dirname, 'migrations'),
    }),
  });
  const { error, results } = await migrator.migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === 'Error') console.error(`migration ${r.migrationName} failed`);
  }
  if (error) throw error;
}

// CLI entry: `node src/db/migrate.ts`
if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  const cfg = loadConfig();
  const db = createDb(cfg.DATABASE_URL, 2);
  try {
    await migrateToLatest(db);
    console.log('migrations up to date');
  } finally {
    await db.destroy();
  }
}
```

- [ ] **Step 6: Create src/auth/passwords.ts (needed by seed)**

```ts
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// OWASP-listed scrypt parameter set: N=2^15, r=8, p=3 → 32 MiB memory per hash.
// Parameters are stored in the hash string so they can be raised later without
// invalidating existing passwords.
const N = 32768;
const R = 8;
const P = 3;
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}
```

- [ ] **Step 7: Create src/db/seed.ts**

```ts
import path from 'node:path';
import { loadConfig } from '../config.ts';
import { hashPassword } from '../auth/passwords.ts';
import { createDb, type Db } from './index.ts';

export const DEMO_EMAIL = 'demo@luarc.test';
export const DEMO_PASSWORD = 'demo-password-123';

/** Idempotent demo data. Safe to run on every container start. */
export async function seed(db: Db): Promise<void> {
  await db
    .insertInto('users')
    .values({ email: DEMO_EMAIL, password_hash: await hashPassword(DEMO_PASSWORD) })
    .onConflict((oc) => oc.column('email').doNothing())
    .execute();
  const owner = await db.selectFrom('users').select('id').where('email', '=', DEMO_EMAIL).executeTakeFirstOrThrow();

  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  await db
    .insertInto('coupons')
    .values([
      { code: 'WELCOME-100', title: 'Welcome bonus', total_quantity: 100, created_by: owner.id },
      { code: 'RACE-50', title: 'Flash sale: 50 units, race for them', total_quantity: 50, created_by: owner.id },
      { code: 'BIG-10000', title: 'Big pool', total_quantity: 10000, created_by: owner.id },
      { code: 'EXPIRED-1', title: 'Expired last week', total_quantity: 10, expires_at: weekAgo, created_by: owner.id },
      { code: 'DISABLED-1', title: 'Disabled by owner', total_quantity: 10, status: 'disabled', created_by: owner.id },
    ])
    .onConflict((oc) => oc.column('code').doNothing())
    .execute();
}

// CLI entry: `node src/db/seed.ts`
if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  const cfg = loadConfig();
  const db = createDb(cfg.DATABASE_URL, 2);
  try {
    await seed(db);
    console.log(`seeded demo user ${DEMO_EMAIL} and 5 coupons`);
  } finally {
    await db.destroy();
  }
}
```

- [ ] **Step 8: Run the tests and typecheck**

Run: `node --env-file=.env.test --test test/db.test.ts && npm run typecheck`
Expected: 4 passing, typecheck clean. Also run the CLIs against the dev database once:

```bash
npm run migrate && npm run seed
```

Expected: `migrations up to date` then `seeded demo user demo@luarc.test and 5 coupons`.

- [ ] **Step 9: Commit**

```bash
git add src/db src/auth/passwords.ts test/db.test.ts
git commit -m "feat(db): schema with named constraints, migrator, idempotent seed"
```

---

### Task 3: App skeleton, problem details, Redis helpers, health, test harness

**Files:**
- Create: `src/lib/problem.ts`, `src/lib/validate.ts`, `src/lib/redis.ts`, `src/express.d.ts`, `src/auth/tokens.ts` (stub is not allowed, so the full file is written here and tested in Task 4), `src/app.ts`, `src/server.ts`, `test/helpers.ts`
- Test: `test/health.test.ts`

**Interfaces:**
- Consumes: `Config`, `Db`, `createDb`, `migrateToLatest`, `hashPassword` from Tasks 1–2.
- Produces:
  - `class HttpProblem extends Error { status: number; slug: string; title: string; detail?: string; extra: Record<string, unknown> }`, `notFound(what?: string): HttpProblem`, `mapPgError(err: unknown): HttpProblem | null`, `notFoundHandler: RequestHandler`, `errorHandler(logger: Logger): ErrorRequestHandler`
  - `parse<T>(schema: ZodType<T>, data: unknown): T` (throws 400), `parseId(raw: string): string` (throws 404 if not a UUID)
  - `type Redis`, `createRedis(url, logger): Redis` (not connected), `rateLimit(redis, logger, { max, windowSeconds, prefix }): RequestHandler`, `interface Cache { get; set; del }`, `createCache(redis, logger): Cache`
  - `interface AuthUser { id: string; email: string }`, `interface Tokens { accessTtlSeconds; refreshTtlSeconds; signAccess(user): Promise<string>; verifyAccess(token): Promise<AuthUser>; newRefreshToken(): { token: string; hash: string }; hashRefreshToken(token): string }`, `createTokens(config: Config): Tokens`
  - `interface AppContext { config; db; redis; logger; tokens; cache }`, `createApp(deps: { config; db; redis; logger }): { app: Express; ctx: AppContext }`
  - Test helpers: `bootTestApp(overrides?: Partial<Config>): Promise<TestContext>`, `resetState(t)`, `createUser(t, email?)`, `createUsers(t, n)`, `createCoupon(t, token, overrides?)`, `api(t, method, path, { token?, body?, headers? })`

- [ ] **Step 1: Write the failing health and error-format test**

`test/health.test.ts`:

```ts
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, bootTestApp, type TestContext } from './helpers.ts';

let t: TestContext;
before(async () => {
  t = await bootTestApp();
});
after(async () => {
  await t.close();
});

test('GET /health reports both dependencies ok', async () => {
  const res = await api(t, 'GET', '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok', checks: { postgres: 'ok', redis: 'ok' } });
});

test('unknown routes return an RFC 9457 problem with a request id', async () => {
  const res = await api(t, 'GET', '/nope', { headers: { 'x-request-id': 'req-123' } });
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /application\/problem\+json/);
  assert.equal(res.headers.get('x-request-id'), 'req-123');
  assert.equal(res.body.type, '/problems/not-found');
  assert.equal(res.body.status, 404);
  assert.equal(res.body.instance, '/nope');
  assert.equal(res.body.request_id, 'req-123');
});

test('a request id is generated when the client sends none', async () => {
  const res = await api(t, 'GET', '/health');
  assert.ok(res.headers.get('x-request-id'));
});

test('malformed JSON bodies are a 400 problem, not a 500', async () => {
  const res = await fetch(`${t.base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.type, '/problems/invalid-json');
});

test('security headers are present and x-powered-by is not', async () => {
  const res = await api(t, 'GET', '/health');
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});
```

Note: the malformed-JSON test hits `/auth/login`, which does not exist until Task 5. Until then Express still parses the body before routing, so the JSON error fires first. The test remains valid after Task 5.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --env-file=.env.test --test test/health.test.ts`
Expected: FAIL, `./helpers.ts` not found.

- [ ] **Step 3: Create src/lib/problem.ts**

```ts
import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';

/** An HTTP error the client should see, rendered as RFC 9457 problem details. */
export class HttpProblem extends Error {
  constructor(
    public readonly status: number,
    public readonly slug: string,
    public readonly title: string,
    public readonly detail?: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(detail ?? title);
    this.name = 'HttpProblem';
  }
}

export function notFound(what = 'Resource'): HttpProblem {
  return new HttpProblem(404, 'not-found', 'Not found', `${what} not found.`);
}

type Mapping = [status: number, slug: string, title: string, detail: string];

// The only place in the codebase that knows pg error codes and constraint names.
// Constraint names come from src/db/migrations/0001_init.ts.
const UNIQUE_VIOLATIONS: Record<string, Mapping> = {
  users_email_key: [409, 'email-taken', 'Email already registered', 'An account with this email already exists.'],
  coupons_code_key: [409, 'code-taken', 'Coupon code already exists', 'Choose a different coupon code.'],
  claims_coupon_id_user_id_key: [409, 'already-claimed', 'Coupon already claimed', 'You have already claimed this coupon.'],
};
const FK_VIOLATIONS: Record<string, Mapping> = {
  claims_coupon_id_fkey: [404, 'not-found', 'Not found', 'Coupon not found.'],
  claims_user_id_fkey: [403, 'unknown-user', 'Unknown user', 'No user exists for this token.'],
  coupons_created_by_fkey: [403, 'unknown-user', 'Unknown user', 'No user exists for this token.'],
};
const CHECK_VIOLATIONS: Record<string, Mapping> = {
  coupons_claimed_within_total: [
    422,
    'quantity-below-claimed',
    'Quantity below claimed count',
    'total_quantity cannot be lower than the number of claims already made.',
  ],
};

export function mapPgError(err: unknown): HttpProblem | null {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  if (!e || typeof e.code !== 'string' || typeof e.constraint !== 'string') return null;
  const table =
    e.code === '23505' ? UNIQUE_VIOLATIONS : e.code === '23503' ? FK_VIOLATIONS : e.code === '23514' ? CHECK_VIOLATIONS : null;
  const hit = table?.[e.constraint];
  return hit ? new HttpProblem(...hit) : null;
}

function toProblem(err: unknown): HttpProblem {
  if (err instanceof HttpProblem) return err;
  const mapped = mapPgError(err);
  if (mapped) return mapped;
  const e = err as { type?: string } | null;
  if (e?.type === 'entity.parse.failed') {
    return new HttpProblem(400, 'invalid-json', 'Malformed JSON', 'Request body is not valid JSON.');
  }
  if (e?.type === 'entity.too.large') {
    return new HttpProblem(413, 'payload-too-large', 'Payload too large', 'Request body exceeds 100kb.');
  }
  return new HttpProblem(500, 'internal', 'Internal server error', 'Something went wrong. Quote the request_id when reporting it.');
}

export const notFoundHandler: RequestHandler = (req) => {
  throw notFound(`Route ${req.method} ${req.path}`);
};

export function errorHandler(logger: Logger): ErrorRequestHandler {
  // Express identifies error middleware by arity, so all four parameters must be declared.
  return (err, req, res, _next) => {
    const problem = toProblem(err);
    const requestId = String(req.id ?? '');
    if (problem.status >= 500) {
      (req.log ?? logger).error({ err, request_id: requestId }, 'unhandled error');
    }
    if (problem.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
    res
      .status(problem.status)
      .type('application/problem+json')
      .json({
        type: `/problems/${problem.slug}`,
        title: problem.title,
        status: problem.status,
        detail: problem.detail,
        instance: req.originalUrl,
        request_id: requestId,
        ...problem.extra,
      });
  };
}
```

- [ ] **Step 4: Create src/lib/validate.ts**

```ts
import { z, type ZodType } from 'zod';
import { HttpProblem, notFound } from './problem.ts';

/** Parse untrusted input or throw a 400 problem listing every issue. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpProblem(400, 'validation-error', 'Request validation failed', 'One or more fields are invalid.', {
      errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

const uuid = z.uuid();

/** A path id that is not a UUID cannot exist, so it is a 404, not a 400. */
export function parseId(raw: string): string {
  const result = uuid.safeParse(raw);
  if (!result.success) throw notFound();
  return result.data;
}
```

- [ ] **Step 5: Create src/lib/redis.ts**

```ts
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
  return client;
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
```

- [ ] **Step 6: Create src/auth/tokens.ts and src/express.d.ts**

`src/auth/tokens.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Config } from '../config.ts';

export interface AuthUser {
  id: string;
  email: string;
}

export interface Tokens {
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  signAccess(user: AuthUser): Promise<string>;
  verifyAccess(token: string): Promise<AuthUser>;
  newRefreshToken(): { token: string; hash: string };
  hashRefreshToken(token: string): string;
}

export function createTokens(config: Config): Tokens {
  const secret = new TextEncoder().encode(config.JWT_SECRET);
  const hashRefreshToken = (token: string) => createHash('sha256').update(token).digest('hex');

  return {
    accessTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
    refreshTtlSeconds: config.REFRESH_TOKEN_TTL_SECONDS,

    // Claim shape follows Supabase Auth (sub, email, role, aud, iss) so a client written
    // against Supabase tokens reads ours unchanged. Nothing in this codebase depends on it.
    signAccess(user) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ email: user.email, role: 'authenticated' })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(user.id)
        .setIssuer(config.JWT_ISSUER)
        .setAudience(config.JWT_AUDIENCE)
        .setIssuedAt(now)
        .setExpirationTime(now + config.ACCESS_TOKEN_TTL_SECONDS)
        .sign(secret);
    },

    async verifyAccess(token) {
      // Explicit algorithm allow-list: alg=none and algorithm confusion are rejected by construction.
      const { payload } = await jwtVerify(token, secret, {
        algorithms: ['HS256'],
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
      });
      if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
        throw new Error('token missing sub or email');
      }
      return { id: payload.sub, email: payload.email };
    },

    // Opaque 256-bit token, returned to the client once; only its SHA-256 is stored.
    newRefreshToken() {
      const token = randomBytes(32).toString('base64url');
      return { token, hash: hashRefreshToken(token) };
    },

    hashRefreshToken,
  };
}
```

`src/express.d.ts`:

```ts
import type { AuthUser } from './auth/tokens.ts';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
```

- [ ] **Step 7: Create src/app.ts**

```ts
import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import { createTokens, type Tokens } from './auth/tokens.ts';
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
  app.use(
    helmet({
      // Swagger UI (Task 12) needs inline script/style from our own origin. Everything else stays default.
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          'script-src': ["'self'", "'unsafe-inline'"],
          'style-src': ["'self'", "'unsafe-inline'"],
        },
      },
    }),
  );
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

  // Route modules are registered here in later tasks:
  //   registerAuthRoutes(app, ctx)    (Task 5)
  //   registerCouponRoutes(app, ctx)  (Task 6)
  //   registerClaimRoutes(app, ctx)   (Task 11)
  //   registerDocs(app)               (Task 12)

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return { app, ctx };
}
```

- [ ] **Step 8: Create src/server.ts**

```ts
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
const db = createDb(config.DATABASE_URL, config.PG_POOL_MAX);
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
```

- [ ] **Step 9: Create test/helpers.ts**

```ts
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
export async function bootTestApp(overrides: Partial<Config> = {}): Promise<TestContext> {
  const config: Config = { ...loadConfig(), ...overrides };
  const logger = pino({ level: 'silent' });
  const db = createDb(config.DATABASE_URL, config.PG_POOL_MAX);
  const redis = createRedis(config.REDIS_URL, logger);
  await redis.connect();
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
      redis.destroy();
    },
  };
  await resetState(t);
  return t;
}

export async function resetState(t: TestContext): Promise<void> {
  await sql`TRUNCATE claims, refresh_tokens, coupons, users RESTART IDENTITY CASCADE`.execute(t.db);
  await t.redis.flushDb();
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
```

- [ ] **Step 10: Run the tests and typecheck**

Run: `node --env-file=.env.test --test test/health.test.ts && npm run typecheck`
Expected: 5 passing, typecheck clean.

Then a manual smoke test of the real server:

```bash
npm run dev &
sleep 2
curl -s localhost:3000/health; echo
curl -si localhost:3000/nope | head -20
kill %1
```

Expected: `{"status":"ok","checks":{"postgres":"ok","redis":"ok"}}`, then a 404 with `Content-Type: application/problem+json`.

- [ ] **Step 11: Commit**

```bash
git add src/lib src/app.ts src/server.ts src/express.d.ts src/auth/tokens.ts test/helpers.ts test/health.test.ts
git commit -m "feat: app skeleton with problem details, health, fail-open redis helpers, test harness"
```

---

### Task 4: Password and token unit tests

**Files:**
- Test: `test/passwords.test.ts`, `test/tokens.test.ts`

**Interfaces:**
- Consumes: `hashPassword`, `verifyPassword` (Task 2), `createTokens` (Task 3), `loadConfig` (Task 1).

- [ ] **Step 1: Write the password tests**

`test/passwords.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/passwords.ts';

test('hash round-trips and encodes its parameters', async () => {
  const hash = await hashPassword('hunter22hunter22');
  assert.ok(hash.startsWith('scrypt$32768$8$3$'), hash);
  assert.equal(hash.split('$').length, 6);
  assert.equal(await verifyPassword('hunter22hunter22', hash), true);
  assert.equal(await verifyPassword('hunter22hunter23', hash), false);
});

test('two hashes of the same password differ (random salt)', async () => {
  const a = await hashPassword('same-password-1');
  const b = await hashPassword('same-password-1');
  assert.notEqual(a, b);
});

test('garbage stored hashes verify as false instead of throwing', async () => {
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
  assert.equal(await verifyPassword('anything', 'bcrypt$1$2$3$4$5'), false);
});
```

- [ ] **Step 2: Write the token tests**

`test/tokens.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { createTokens } from '../src/auth/tokens.ts';
import { loadConfig } from '../src/config.ts';

const config = loadConfig();
const tokens = createTokens(config);
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'a@b.c' };

test('access token round-trips the user', async () => {
  const jwt = await tokens.signAccess(user);
  assert.deepEqual(await tokens.verifyAccess(jwt), user);
});

test('access token carries Supabase-shaped claims', async () => {
  const jwt = await tokens.signAccess(user);
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString());
  assert.equal(payload.sub, user.id);
  assert.equal(payload.email, user.email);
  assert.equal(payload.role, 'authenticated');
  assert.equal(payload.aud, config.JWT_AUDIENCE);
  assert.equal(payload.iss, config.JWT_ISSUER);
  assert.equal(payload.exp - payload.iat, config.ACCESS_TOKEN_TTL_SECONDS);
});

test('tampered, foreign-audience, and expired tokens are rejected', async () => {
  const good = await tokens.signAccess(user);
  const tampered = good.slice(0, -2) + (good.endsWith('a') ? 'bb' : 'aa');
  await assert.rejects(tokens.verifyAccess(tampered));

  const secret = new TextEncoder().encode(config.JWT_SECRET);
  const now = Math.floor(Date.now() / 1000);
  const wrongAud = await new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer(config.JWT_ISSUER)
    .setAudience('someone-else')
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(secret);
  await assert.rejects(tokens.verifyAccess(wrongAud));

  const expired = await new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setIssuedAt(now - 120)
    .setExpirationTime(now - 60)
    .sign(secret);
  await assert.rejects(tokens.verifyAccess(expired));
});

test('refresh tokens are 32 random bytes, hashed with sha256', () => {
  const { token, hash } = tokens.newRefreshToken();
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(tokens.hashRefreshToken(token), hash);
  assert.notEqual(tokens.newRefreshToken().token, token);
});
```

- [ ] **Step 3: Run the tests**

Run: `node --env-file=.env.test --test test/passwords.test.ts test/tokens.test.ts`
Expected: 7 passing. (Both modules already exist, so these pass immediately; they lock the behaviour in before the auth routes depend on it.)

- [ ] **Step 4: Commit**

```bash
git add test/passwords.test.ts test/tokens.test.ts
git commit -m "test: lock scrypt parameters and JWT claim shape"
```

---

### Task 5: Auth routes, requireAuth middleware, rate limiting

**Files:**
- Create: `src/auth/middleware.ts`, `src/auth/routes.ts`
- Modify: `src/app.ts` (register auth routes)
- Test: `test/auth.test.ts`

**Interfaces:**
- Consumes: `AppContext`, `Tokens`, `HttpProblem`, `parse`, `rateLimit`, `hashPassword`, `verifyPassword`.
- Produces: `requireAuth(tokens: Tokens): RequestHandler` (sets `req.user`), `registerAuthRoutes(app: Express, ctx: AppContext): void`, `issueTokenPair(ctx: AppContext, user: AuthUser, db?: Db): Promise<TokenPair>` where `TokenPair = { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string }`.

- [ ] **Step 1: Write the failing auth tests**

`test/auth.test.ts`:

```ts
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, bootTestApp, createUser, resetState, TEST_PASSWORD, type TestContext } from './helpers.ts';

let t: TestContext;
before(async () => {
  t = await bootTestApp();
});
after(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetState(t);
});

const creds = { email: 'Alice@Example.com', password: 'a-long-enough-password' };

test('register returns the user and a token pair; email is normalised', async () => {
  const res = await api(t, 'POST', '/auth/register', { body: creds });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.email, 'alice@example.com');
  assert.equal(res.body.token_type, 'Bearer');
  assert.equal(res.body.expires_in, t.config.ACCESS_TOKEN_TTL_SECONDS);
  assert.ok(res.body.access_token);
  assert.ok(res.body.refresh_token);
  assert.equal('password_hash' in res.body.user, false);
});

test('register rejects duplicates and invalid bodies', async () => {
  await api(t, 'POST', '/auth/register', { body: creds });
  const dup = await api(t, 'POST', '/auth/register', { body: creds });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.type, '/problems/email-taken');

  const bad = await api(t, 'POST', '/auth/register', { body: { email: 'nope', password: 'short' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.type, '/problems/validation-error');
  assert.deepEqual(
    bad.body.errors.map((e: { path: string }) => e.path).sort(),
    ['email', 'password'],
  );
});

test('login succeeds with correct credentials', async () => {
  await api(t, 'POST', '/auth/register', { body: creds });
  const res = await api(t, 'POST', '/auth/login', { body: creds });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, 'alice@example.com');
  assert.ok(res.body.access_token);
});

test('login gives an identical 401 for unknown email and wrong password', async () => {
  await api(t, 'POST', '/auth/register', { body: creds });
  const wrongPassword = await api(t, 'POST', '/auth/login', { body: { ...creds, password: 'wrong-password-123' } });
  const unknownEmail = await api(t, 'POST', '/auth/login', { body: { email: 'nobody@example.com', password: creds.password } });
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, 401);
  const strip = (b: Record<string, unknown>) => ({ ...b, request_id: undefined });
  assert.deepEqual(strip(wrongPassword.body), strip(unknownEmail.body));
  assert.equal(wrongPassword.body.type, '/problems/invalid-credentials');
  assert.equal(wrongPassword.headers.get('www-authenticate'), 'Bearer');
});

test('protected routes require a valid bearer token', async () => {
  const none = await api(t, 'GET', '/me');
  assert.equal(none.status, 401);
  assert.equal(none.body.type, '/problems/unauthorized');
  const garbage = await api(t, 'GET', '/me', { token: 'not.a.jwt' });
  assert.equal(garbage.status, 401);
  const user = await createUser(t);
  const ok = await api(t, 'GET', '/me', { token: user.token });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.email, user.email);
  assert.equal(ok.body.id, user.id);
});

test('refresh rotates the token and the old one stops working', async () => {
  const reg = await api(t, 'POST', '/auth/register', { body: creds });
  const first = reg.body.refresh_token;

  const rotated = await api(t, 'POST', '/auth/refresh', { body: { refresh_token: first } });
  assert.equal(rotated.status, 200);
  assert.ok(rotated.body.access_token);
  assert.notEqual(rotated.body.refresh_token, first);

  const replay = await api(t, 'POST', '/auth/refresh', { body: { refresh_token: first } });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.type, '/problems/invalid-refresh-token');
});

test('reusing a rotated refresh token revokes the whole family', async () => {
  const reg = await api(t, 'POST', '/auth/register', { body: creds });
  const first = reg.body.refresh_token;
  const second = (await api(t, 'POST', '/auth/refresh', { body: { refresh_token: first } })).body.refresh_token;

  // Attacker replays the old token → detected → every live token for the user is revoked.
  await api(t, 'POST', '/auth/refresh', { body: { refresh_token: first } });

  const victim = await api(t, 'POST', '/auth/refresh', { body: { refresh_token: second } });
  assert.equal(victim.status, 401);
});

test('logout revokes the refresh token and always returns 204', async () => {
  const reg = await api(t, 'POST', '/auth/register', { body: creds });
  const out = await api(t, 'POST', '/auth/logout', { body: { refresh_token: reg.body.refresh_token } });
  assert.equal(out.status, 204);
  const again = await api(t, 'POST', '/auth/refresh', { body: { refresh_token: reg.body.refresh_token } });
  assert.equal(again.status, 401);
  const unknown = await api(t, 'POST', '/auth/logout', { body: { refresh_token: 'x'.repeat(43) } });
  assert.equal(unknown.status, 204);
});

test('auth routes are rate limited per IP', async () => {
  const limited = await bootTestApp({ RATE_LIMIT_AUTH_MAX: 3, RATE_LIMIT_AUTH_WINDOW_SECONDS: 60 });
  try {
    const attempt = () => api(limited, 'POST', '/auth/login', { body: { email: 'x@y.z', password: TEST_PASSWORD } });
    for (let i = 0; i < 3; i++) assert.equal((await attempt()).status, 401);
    const blocked = await attempt();
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.type, '/problems/rate-limited');
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    assert.ok(blocked.body.retry_after >= 1);
  } finally {
    await limited.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --env-file=.env.test --test test/auth.test.ts`
Expected: FAIL, every request 404 (routes not registered).

- [ ] **Step 3: Create src/auth/middleware.ts**

```ts
import type { RequestHandler } from 'express';
import { HttpProblem } from '../lib/problem.ts';
import type { Tokens } from './tokens.ts';

/** Verifies the bearer token and sets req.user. Express 5 forwards the thrown problem to the error handler. */
export function requireAuth(tokens: Tokens): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!token) throw new HttpProblem(401, 'unauthorized', 'Unauthorized', 'Missing bearer token.');
    try {
      req.user = await tokens.verifyAccess(token);
    } catch {
      throw new HttpProblem(401, 'unauthorized', 'Unauthorized', 'Invalid or expired token.');
    }
    next();
  };
}
```

- [ ] **Step 4: Create src/auth/routes.ts**

```ts
import { randomBytes } from 'node:crypto';
import type { Express } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import type { Db } from '../db/index.ts';
import { HttpProblem, notFound } from '../lib/problem.ts';
import { rateLimit } from '../lib/redis.ts';
import { parse } from '../lib/validate.ts';
import { requireAuth } from './middleware.ts';
import { hashPassword, verifyPassword } from './passwords.ts';
import type { AuthUser } from './tokens.ts';

const credentials = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(8).max(128),
});
const refreshBody = z.object({ refresh_token: z.string().min(20).max(200) });

export interface TokenPair {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
}

/** Mint an access token and persist a new refresh token. Pass a transaction to make it atomic with other writes. */
export async function issueTokenPair(ctx: AppContext, user: AuthUser, db: Db = ctx.db): Promise<TokenPair> {
  const { token, hash } = ctx.tokens.newRefreshToken();
  await db
    .insertInto('refresh_tokens')
    .values({ user_id: user.id, token_hash: hash, expires_at: new Date(Date.now() + ctx.tokens.refreshTtlSeconds * 1000) })
    .execute();
  return {
    access_token: await ctx.tokens.signAccess(user),
    token_type: 'Bearer',
    expires_in: ctx.tokens.accessTtlSeconds,
    refresh_token: token,
  };
}

const invalidCredentials = () =>
  new HttpProblem(401, 'invalid-credentials', 'Invalid credentials', 'Email or password is incorrect.');
const invalidRefresh = () =>
  new HttpProblem(401, 'invalid-refresh-token', 'Invalid refresh token', 'The refresh token is unknown, expired, or revoked.');

export function registerAuthRoutes(app: Express, ctx: AppContext): void {
  const { db, tokens, config } = ctx;

  // Verified against when the email is unknown so response time does not reveal account existence.
  const dummyHash = hashPassword(randomBytes(16).toString('hex'));

  app.use(
    '/auth',
    rateLimit(ctx.redis, ctx.logger, {
      max: config.RATE_LIMIT_AUTH_MAX,
      windowSeconds: config.RATE_LIMIT_AUTH_WINDOW_SECONDS,
      prefix: 'rl:auth',
    }),
  );

  app.post('/auth/register', async (req, res) => {
    const { email, password } = parse(credentials, req.body);
    const password_hash = await hashPassword(password);
    // A duplicate email raises 23505 on users_email_key → mapped to 409 email-taken.
    const user = await db
      .insertInto('users')
      .values({ email, password_hash })
      .returning(['id', 'email', 'created_at'])
      .executeTakeFirstOrThrow();
    res.status(201).json({ user, ...(await issueTokenPair(ctx, user)) });
  });

  app.post('/auth/login', async (req, res) => {
    const { email, password } = parse(credentials, req.body);
    const user = await db
      .selectFrom('users')
      .select(['id', 'email', 'created_at', 'password_hash'])
      .where('email', '=', email)
      .executeTakeFirst();
    const ok = await verifyPassword(password, user?.password_hash ?? (await dummyHash));
    if (!user || !ok) throw invalidCredentials();
    const { password_hash: _omit, ...publicUser } = user;
    res.json({ user: publicUser, ...(await issueTokenPair(ctx, user)) });
  });

  app.post('/auth/refresh', async (req, res) => {
    const { refresh_token } = parse(refreshBody, req.body);
    const hash = tokens.hashRefreshToken(refresh_token);

    // Returns 'invalid' instead of throwing so the reuse-detection revocation below COMMITS.
    // Throwing inside the callback would roll it back.
    const outcome = await db.transaction().execute(async (trx): Promise<TokenPair | 'invalid'> => {
      // FOR UPDATE serialises concurrent refreshes of the same token; the loser sees revoked_at.
      const row = await trx.selectFrom('refresh_tokens').selectAll().where('token_hash', '=', hash).forUpdate().executeTakeFirst();
      if (!row) return 'invalid';
      if (row.revoked_at) {
        // Replay of a rotated token: someone holds a stolen copy. Revoke every live token for the user.
        await trx
          .updateTable('refresh_tokens')
          .set({ revoked_at: sql<Date>`now()` })
          .where('user_id', '=', row.user_id)
          .where('revoked_at', 'is', null)
          .execute();
        return 'invalid';
      }
      if (row.expires_at.getTime() <= Date.now()) return 'invalid';

      await trx.updateTable('refresh_tokens').set({ revoked_at: sql<Date>`now()` }).where('id', '=', row.id).execute();
      const user = await trx.selectFrom('users').select(['id', 'email']).where('id', '=', row.user_id).executeTakeFirstOrThrow();
      return issueTokenPair(ctx, user, trx);
    });

    if (outcome === 'invalid') throw invalidRefresh();
    res.json(outcome);
  });

  app.post('/auth/logout', async (req, res) => {
    const { refresh_token } = parse(refreshBody, req.body);
    await db
      .updateTable('refresh_tokens')
      .set({ revoked_at: sql<Date>`now()` })
      .where('token_hash', '=', tokens.hashRefreshToken(refresh_token))
      .where('revoked_at', 'is', null)
      .execute();
    res.status(204).end();
  });

  app.get('/me', requireAuth(tokens), async (req, res) => {
    const user = await db.selectFrom('users').select(['id', 'email', 'created_at']).where('id', '=', req.user!.id).executeTakeFirst();
    if (!user) throw notFound('User');
    res.json(user);
  });
}
```

- [ ] **Step 5: Register the routes in src/app.ts**

Add the import at the top of `src/app.ts`:

```ts
import { registerAuthRoutes } from './auth/routes.ts';
```

Replace the comment block `// Route modules are registered here in later tasks: ...` with:

```ts
  registerAuthRoutes(app, ctx);
  // registerCouponRoutes(app, ctx)  (Task 6)
  // registerClaimRoutes(app, ctx)   (Task 11)
  // registerDocs(app)               (Task 12)
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `node --env-file=.env.test --test test/auth.test.ts && npm run typecheck`
Expected: 9 passing, typecheck clean.

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: all passing (config 4, db 4, health 5, passwords 3, tokens 4, auth 9).

- [ ] **Step 8: Commit**

```bash
git add src/auth src/app.ts test/auth.test.ts
git commit -m "feat(auth): register, login, rotating refresh tokens with reuse detection, rate limit"
```

---

### Task 6: Coupons — create, get, list with filters and keyset pagination

**Files:**
- Create: `src/lib/pagination.ts`, `src/coupons/service.ts`, `src/coupons/routes.ts`
- Modify: `src/app.ts`
- Test: `test/coupons.test.ts`

**Interfaces:**
- Consumes: `AppContext`, `requireAuth`, `parse`, `parseId`, `notFound`, `HttpProblem`, `Db`, `CouponStatus`.
- Produces:
  - `pageQuery` (zod shape `{ limit, cursor }`), `encodeCursor(v: string | number): string`, `decodeStringCursor(c: string): string`, `decodeIntCursor(c: string): number`, `page<T>(rows: T[], limit: number, key: (row: T) => string | number): { data: T[]; next_cursor: string | null }`
  - `interface CouponView { id; code; title; description; status; total_quantity; claimed_count; remaining; expires_at; version; created_by; created_at; updated_at; claimed_by_me }`
  - `createCoupon(db, ownerId, input: NewCoupon): Promise<CouponView>`, `getCoupon(db, id, viewerId): Promise<CouponView | undefined>`, `listCoupons(db, viewerId, f: CouponFilters): Promise<Page<CouponView>>`, `STATS_CACHE_KEY = 'cache:coupons:stats'`
  - `registerCouponRoutes(app, ctx)` registering `POST /coupons`, `GET /coupons`, `GET /coupons/:id` (Tasks 7, 8, 10 add PATCH, claims, stats to the same function).

- [ ] **Step 1: Write the failing coupon tests**

`test/coupons.test.ts`:

```ts
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, bootTestApp, createCoupon, createUser, resetState, type TestContext, type TestUser } from './helpers.ts';

let t: TestContext;
let owner: TestUser;
let other: TestUser;
before(async () => {
  t = await bootTestApp();
});
after(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetState(t);
  owner = await createUser(t);
  other = await createUser(t);
});

test('create returns the full view with derived fields', async () => {
  const res = await api(t, 'POST', '/coupons', {
    token: owner.token,
    body: { code: 'summer-50', title: 'Summer', total_quantity: 50, expires_at: '2030-01-01T00:00:00Z' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('location'), `/coupons/${res.body.id}`);
  assert.equal(res.body.code, 'SUMMER-50', 'codes are upper-cased');
  assert.equal(res.body.status, 'active');
  assert.equal(res.body.total_quantity, 50);
  assert.equal(res.body.claimed_count, 0);
  assert.equal(res.body.remaining, 50);
  assert.equal(res.body.version, 1);
  assert.equal(res.body.claimed_by_me, false);
  assert.equal(res.body.created_by, owner.id);
  assert.equal(res.body.expires_at, '2030-01-01T00:00:00.000Z');
  assert.equal(res.body.description, null);
});

test('create validates input and rejects duplicate codes', async () => {
  const bad = await api(t, 'POST', '/coupons', { token: owner.token, body: { code: 'bad code!', title: '', total_quantity: 0 } });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.errors.map((e: { path: string }) => e.path).sort(), ['code', 'title', 'total_quantity']);

  await createCoupon(t, owner.token, { code: 'DUP-1' });
  const dup = await api(t, 'POST', '/coupons', { token: other.token, body: { code: 'dup-1', title: 'x', total_quantity: 1 } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.type, '/problems/code-taken');
});

test('create requires authentication', async () => {
  const res = await api(t, 'POST', '/coupons', { body: { code: 'X-1', title: 'x', total_quantity: 1 } });
  assert.equal(res.status, 401);
});

test('get returns 404 for unknown and non-uuid ids', async () => {
  assert.equal((await api(t, 'GET', '/coupons/00000000-0000-4000-8000-000000000000', { token: owner.token })).status, 404);
  assert.equal((await api(t, 'GET', '/coupons/not-a-uuid', { token: owner.token })).status, 404);
  const created = await createCoupon(t, owner.token);
  const got = await api(t, 'GET', `/coupons/${created.id}`, { token: other.token });
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, created);
});

test('list filters by status, availability, and text; orders by code', async () => {
  await createCoupon(t, owner.token, { code: 'A-ACTIVE', title: 'Alpha' });
  const disabled = await createCoupon(t, owner.token, { code: 'B-DISABLED', title: 'Beta' });
  const soldOut = await createCoupon(t, owner.token, { code: 'C-SOLDOUT', title: 'Gamma', total_quantity: 2 });
  await createCoupon(t, owner.token, { code: 'D-EXPIRED', title: 'Delta', expires_at: '2020-01-01T00:00:00Z' });
  // Fabricate states directly; claims and PATCH arrive in later tasks.
  await t.db.updateTable('coupons').set({ status: 'disabled' }).where('id', '=', disabled.id).execute();
  await t.db.updateTable('coupons').set({ claimed_count: 2 }).where('id', '=', soldOut.id).execute();

  const all = await api(t, 'GET', '/coupons', { token: other.token });
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.data.map((c: { code: string }) => c.code), ['A-ACTIVE', 'B-DISABLED', 'C-SOLDOUT', 'D-EXPIRED']);
  assert.equal(all.body.next_cursor, null);

  const active = await api(t, 'GET', '/coupons?status=active', { token: other.token });
  assert.deepEqual(active.body.data.map((c: { code: string }) => c.code), ['A-ACTIVE', 'C-SOLDOUT', 'D-EXPIRED']);

  const available = await api(t, 'GET', '/coupons?available=true', { token: other.token });
  assert.deepEqual(available.body.data.map((c: { code: string }) => c.code), ['A-ACTIVE']);

  const search = await api(t, 'GET', '/coupons?q=amm', { token: other.token });
  assert.deepEqual(search.body.data.map((c: { code: string }) => c.code), ['C-SOLDOUT']);
  const byCode = await api(t, 'GET', '/coupons?q=d-exp', { token: other.token });
  assert.deepEqual(byCode.body.data.map((c: { code: string }) => c.code), ['D-EXPIRED']);
});

test('list paginates with an opaque keyset cursor and no gaps or duplicates', async () => {
  for (let i = 0; i < 5; i++) await createCoupon(t, owner.token, { code: `P-${i}` });
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const url = `/coupons?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await api(t, 'GET', url, { token: owner.token });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.length <= 2);
    seen.push(...res.body.data.map((c: { code: string }) => c.code));
    cursor = res.body.next_cursor;
    pages++;
  } while (cursor);
  assert.equal(pages, 3);
  assert.deepEqual(seen, ['P-0', 'P-1', 'P-2', 'P-3', 'P-4']);

  const badCursor = await api(t, 'GET', '/coupons?cursor=%%%', { token: owner.token });
  assert.equal(badCursor.status, 400);
  const badLimit = await api(t, 'GET', '/coupons?limit=500', { token: owner.token });
  assert.equal(badLimit.status, 400);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --env-file=.env.test --test test/coupons.test.ts`
Expected: FAIL, 404 on every coupon route.

- [ ] **Step 3: Create src/lib/pagination.ts**

```ts
import { z } from 'zod';
import { HttpProblem } from './problem.ts';

export const pageQuery = {
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
};

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

// Cursors are opaque to clients: base64url of the last row's sort key.
export function encodeCursor(value: string | number): string {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

const badCursor = () => new HttpProblem(400, 'validation-error', 'Invalid cursor', 'The cursor is malformed. Start again without one.');

export function decodeStringCursor(cursor: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw badCursor();
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!decoded) throw badCursor();
  return decoded;
}

export function decodeIntCursor(cursor: string): number {
  const n = Number(decodeStringCursor(cursor));
  if (!Number.isSafeInteger(n) || n < 0) throw badCursor();
  return n;
}

/** Callers fetch limit + 1 rows; this trims the extra and derives next_cursor from the last kept row. */
export function page<T>(rows: T[], limit: number, key: (row: T) => string | number): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return { data, next_cursor: hasMore && last !== undefined ? encodeCursor(key(last)) : null };
}
```

- [ ] **Step 4: Create src/coupons/service.ts (create/get/list; later tasks append to this file)**

```ts
import { sql } from 'kysely';
import type { CouponStatus, Db } from '../db/index.ts';
import { decodeStringCursor, page, type Page } from '../lib/pagination.ts';

export const STATS_CACHE_KEY = 'cache:coupons:stats';

export interface CouponView {
  id: string;
  code: string;
  title: string;
  description: string | null;
  status: CouponStatus;
  total_quantity: number;
  claimed_count: number;
  remaining: number;
  expires_at: Date | null;
  version: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  claimed_by_me: boolean;
}

export interface NewCoupon {
  code: string;
  title: string;
  description?: string | null;
  total_quantity: number;
  expires_at?: string | null;
}

export interface CouponFilters {
  status?: CouponStatus;
  available?: boolean;
  q?: string;
  limit: number;
  cursor?: string;
}

/** The one SELECT shape every coupon read uses: row + remaining + whether the viewer holds a claim. */
function couponView(db: Db, viewerId: string) {
  return db
    .selectFrom('coupons as c')
    .leftJoin('claims as mine', (join) => join.onRef('mine.coupon_id', '=', 'c.id').on('mine.user_id', '=', viewerId))
    .select([
      'c.id',
      'c.code',
      'c.title',
      'c.description',
      'c.status',
      'c.total_quantity',
      'c.claimed_count',
      'c.expires_at',
      'c.version',
      'c.created_by',
      'c.created_at',
      'c.updated_at',
      sql<number>`c.total_quantity - c.claimed_count`.as('remaining'),
      sql<boolean>`mine.id IS NOT NULL`.as('claimed_by_me'),
    ]);
}

export async function getCoupon(db: Db, id: string, viewerId: string): Promise<CouponView | undefined> {
  return couponView(db, viewerId).where('c.id', '=', id).executeTakeFirst();
}

export async function createCoupon(db: Db, ownerId: string, input: NewCoupon): Promise<CouponView> {
  // A duplicate code raises 23505 on coupons_code_key → mapped to 409 code-taken.
  const { id } = await db
    .insertInto('coupons')
    .values({
      code: input.code,
      title: input.title,
      description: input.description ?? null,
      total_quantity: input.total_quantity,
      expires_at: input.expires_at ? new Date(input.expires_at) : null,
      created_by: ownerId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return (await getCoupon(db, id, ownerId))!;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function listCoupons(db: Db, viewerId: string, f: CouponFilters): Promise<Page<CouponView>> {
  let q = couponView(db, viewerId);
  if (f.status) q = q.where('c.status', '=', f.status);
  if (f.available) {
    q = q
      .where('c.status', '=', 'active')
      .where((eb) => eb.or([eb('c.expires_at', 'is', null), eb('c.expires_at', '>', sql<Date>`now()`)]))
      .where((eb) => eb('c.claimed_count', '<', eb.ref('c.total_quantity')));
  }
  if (f.q) {
    // ponytail: ILIKE with a leading wildcard is a sequential scan; add a pg_trgm GIN index if the pool grows large.
    const like = `%${escapeLike(f.q)}%`;
    q = q.where((eb) => eb.or([eb('c.code', 'ilike', like), eb('c.title', 'ilike', like)]));
  }
  if (f.cursor) q = q.where('c.code', '>', decodeStringCursor(f.cursor));
  const rows = await q.orderBy('c.code', 'asc').limit(f.limit + 1).execute();
  return page(rows, f.limit, (r) => r.code);
}
```

- [ ] **Step 5: Create src/coupons/routes.ts**

```ts
import type { Express } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import { requireAuth } from '../auth/middleware.ts';
import { pageQuery } from '../lib/pagination.ts';
import { notFound } from '../lib/problem.ts';
import { parse, parseId } from '../lib/validate.ts';
import { createCoupon, getCoupon, listCoupons, STATS_CACHE_KEY } from './service.ts';

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,31}$/, 'must be 2-32 characters of A-Z, 0-9 and hyphens');
const title = z.string().trim().min(1).max(120);
const description = z.string().trim().max(2000).nullish();
const totalQuantity = z.number().int().min(1).max(1_000_000_000);
const expiresAt = z.iso.datetime({ offset: true }).nullish();
const status = z.enum(['active', 'disabled']);

const createBody = z.object({ code, title, description, total_quantity: totalQuantity, expires_at: expiresAt });

const listQuery = z.object({
  status: status.optional(),
  available: z.stringbool().optional(),
  q: z.string().trim().min(1).max(64).optional(),
  ...pageQuery,
});

export function registerCouponRoutes(app: Express, ctx: AppContext): void {
  const auth = requireAuth(ctx.tokens);

  app.post('/coupons', auth, async (req, res) => {
    const input = parse(createBody, req.body);
    const coupon = await createCoupon(ctx.db, req.user!.id, input);
    await ctx.cache.del(STATS_CACHE_KEY);
    res.status(201).location(`/coupons/${coupon.id}`).json(coupon);
  });

  app.get('/coupons', auth, async (req, res) => {
    const filters = parse(listQuery, req.query);
    res.json(await listCoupons(ctx.db, req.user!.id, filters));
  });

  // GET /coupons/stats is registered here in Task 10 and MUST come before /coupons/:id.

  app.get('/coupons/:id', auth, async (req, res) => {
    const id = parseId(req.params.id);
    const coupon = await getCoupon(ctx.db, id, req.user!.id);
    if (!coupon) throw notFound('Coupon');
    res.json(coupon);
  });

  // PATCH /coupons/:id            (Task 7)
  // POST  /coupons/:id/claims     (Task 8)
}
```

- [ ] **Step 6: Register in src/app.ts**

Add the import:

```ts
import { registerCouponRoutes } from './coupons/routes.ts';
```

Replace the `// registerCouponRoutes(app, ctx)  (Task 6)` comment with `registerCouponRoutes(app, ctx);`.

- [ ] **Step 7: Run the tests and typecheck**

Run: `node --env-file=.env.test --test test/coupons.test.ts && npm run typecheck`
Expected: 6 passing, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/pagination.ts src/coupons src/app.ts test/coupons.test.ts
git commit -m "feat(coupons): create, get, filtered list with keyset pagination"
```

---

### Task 7: PATCH /coupons/:id with version-based optimistic locking

**Files:**
- Modify: `src/coupons/service.ts` (append `updateCoupon`), `src/coupons/routes.ts` (add PATCH)
- Test: `test/coupons.test.ts` (append)

**Interfaces:**
- Produces: `interface CouponPatch { version: number; title?: string; description?: string | null; total_quantity?: number; status?: CouponStatus; expires_at?: string | null }`, `updateCoupon(db, id, ownerId, patch: CouponPatch): Promise<CouponView>` (throws 404 / 403 / 409 `version-conflict` with `current_version`; 23514 on `coupons_claimed_within_total` surfaces as 422 via `mapPgError`).

- [ ] **Step 1: Append the failing PATCH tests to test/coupons.test.ts**

```ts
test('PATCH with the current version succeeds and bumps version', async () => {
  const c = await createCoupon(t, owner.token, { title: 'Before' });
  const res = await api(t, 'PATCH', `/coupons/${c.id}`, { token: owner.token, body: { version: 1, title: 'After', description: 'Now with text' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'After');
  assert.equal(res.body.description, 'Now with text');
  assert.equal(res.body.version, 2);
  assert.notEqual(res.body.updated_at, c.updated_at);
});

test('PATCH with a stale version is a 409 that reports the current version', async () => {
  const c = await createCoupon(t, owner.token);
  await api(t, 'PATCH', `/coupons/${c.id}`, { token: owner.token, body: { version: 1, title: 'first edit' } });
  const stale = await api(t, 'PATCH', `/coupons/${c.id}`, { token: owner.token, body: { version: 1, title: 'second edit' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.type, '/problems/version-conflict');
  assert.equal(stale.body.current_version, 2);
  const unchanged = await api(t, 'GET', `/coupons/${c.id}`, { token: owner.token });
  assert.equal(unchanged.body.title, 'first edit');
});

test('PATCH is owner-only and validates the body', async () => {
  const c = await createCoupon(t, owner.token);
  const forbidden = await api(t, 'PATCH', `/coupons/${c.id}`, { token: other.token, body: { version: 1, title: 'hijack' } });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.type, '/problems/forbidden');

  const noVersion = await api(t, 'PATCH', `/coupons/${c.id}`, { token: owner.token, body: { title: 'x' } });
  assert.equal(noVersion.status, 400);
  const nothingToChange = await api(t, 'PATCH', `/coupons/${c.id}`, { token: owner.token, body: { version: 1 } });
  assert.equal(nothingToChange.status, 400);
  const codeImmutable = await api(t, 'PATCH', `/coupons/${c.id}`, { token: owner.token, body: { version: 1, code: 'NEW' } });
  assert.equal(codeImmutable.status, 400);

  const missing = await api(t, 'PATCH', '/coupons/00000000-0000-4000-8000-000000000000', { token: owner.token, body: { version: 1, title: 'x' } });
  assert.equal(missing.status, 404);
});

test('PATCH cannot shrink total_quantity below claimed_count (DB CHECK → 422)', async () => {
  const c = await createCoupon(t, owner.token, { total_quantity: 10 });
  await t.db.updateTable('coupons').set({ claimed_count: 5 }).where('id', '=', c.id).execute();
  const shrink = await api(t, 'PATCH', `/coupons/${c.id}`, { token: owner.token, body: { version: 1, total_quantity: 3 } });
  assert.equal(shrink.status, 422);
  assert.equal(shrink.body.type, '/problems/quantity-below-claimed');
  const grow = await api(t, 'PATCH', `/coupons/${c.id}`, { token: owner.token, body: { version: 1, total_quantity: 5 } });
  assert.equal(grow.status, 200);
  assert.equal(grow.body.remaining, 0);
});

test('PATCH can disable, set and clear expiry', async () => {
  const c = await createCoupon(t, owner.token, { expires_at: '2030-01-01T00:00:00Z' });
  const disabled = await api(t, 'PATCH', `/coupons/${c.id}`, { token: owner.token, body: { version: 1, status: 'disabled', expires_at: null } });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.status, 'disabled');
  assert.equal(disabled.body.expires_at, null);
  const listed = await api(t, 'GET', '/coupons?available=true', { token: owner.token });
  assert.equal(listed.body.data.length, 0);
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `node --env-file=.env.test --test test/coupons.test.ts`
Expected: the 5 new tests FAIL with 404 (no PATCH route); the earlier 6 still pass.

- [ ] **Step 3: Append updateCoupon to src/coupons/service.ts**

Add `HttpProblem` and `notFound` to the imports at the top of the file:

```ts
import { HttpProblem, notFound } from '../lib/problem.ts';
```

Append:

```ts
export interface CouponPatch {
  version: number;
  title?: string;
  description?: string | null;
  total_quantity?: number;
  status?: CouponStatus;
  expires_at?: string | null;
}

/**
 * Optimistic locking. `version` increments only on edits, never on claims, so an editor of a
 * hot coupon is not livelocked by the claim counter changing underneath them (which is why
 * this is a body field and not an ETag/If-Match pair). The WHERE clause carries ownership,
 * the version check, and the id in one statement; the CHECK constraint arbitrates shrinking
 * total_quantity below claimed_count (23514 → 422 in lib/problem.ts).
 */
export async function updateCoupon(db: Db, id: string, ownerId: string, patch: CouponPatch): Promise<CouponView> {
  const updated = await db
    .updateTable('coupons')
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.total_quantity !== undefined ? { total_quantity: patch.total_quantity } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.expires_at !== undefined ? { expires_at: patch.expires_at === null ? null : new Date(patch.expires_at) } : {}),
      version: sql<number>`version + 1`,
      updated_at: sql<Date>`now()`,
    })
    .where('id', '=', id)
    .where('created_by', '=', ownerId)
    .where('version', '=', patch.version)
    .returning('id')
    .executeTakeFirst();

  if (!updated) {
    // Zero rows: work out which precondition failed, in order of what the client can act on.
    const current = await db.selectFrom('coupons').select(['created_by', 'version']).where('id', '=', id).executeTakeFirst();
    if (!current) throw notFound('Coupon');
    if (current.created_by !== ownerId) {
      throw new HttpProblem(403, 'forbidden', 'Forbidden', 'Only the coupon owner can modify it.');
    }
    throw new HttpProblem(
      409,
      'version-conflict',
      'Version conflict',
      `Coupon is at version ${current.version}; you sent ${patch.version}. Re-read it and retry.`,
      { current_version: current.version },
    );
  }
  return (await getCoupon(db, id, ownerId))!;
}
```

- [ ] **Step 4: Add the PATCH route to src/coupons/routes.ts**

Add `updateCoupon` to the service import. Add the schema after `createBody`:

```ts
const patchBody = z
  .strictObject({
    version: z.number().int().min(1),
    title: title.optional(),
    description,
    total_quantity: totalQuantity.optional(),
    status: status.optional(),
    expires_at: expiresAt,
  })
  .refine(
    (b) => ['title', 'description', 'total_quantity', 'status', 'expires_at'].some((k) => b[k as keyof typeof b] !== undefined),
    { message: 'At least one editable field is required', path: [] },
  );
```

Replace the `// PATCH /coupons/:id            (Task 7)` comment with:

```ts
  app.patch('/coupons/:id', auth, async (req, res) => {
    const id = parseId(req.params.id);
    const patch = parse(patchBody, req.body);
    const coupon = await updateCoupon(ctx.db, id, req.user!.id, patch);
    await ctx.cache.del(STATS_CACHE_KEY);
    res.json(coupon);
  });
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `node --env-file=.env.test --test test/coupons.test.ts && npm run typecheck`
Expected: 11 passing, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/coupons test/coupons.test.ts
git commit -m "feat(coupons): PATCH with version-based optimistic locking"
```

---

### Task 8: The claim transaction

**Files:**
- Modify: `src/coupons/service.ts` (append `claimCoupon`), `src/coupons/routes.ts` (add `POST /coupons/:id/claims`)
- Test: `test/claims.test.ts`

**Interfaces:**
- Produces: `interface ClaimResult { id: number; coupon_id: string; user_id: string; claimed_at: Date; remaining: number }`, `claimCoupon(db, couponId, userId): Promise<ClaimResult>`. Errors: 23505 `claims_coupon_id_user_id_key` → 409 `already-claimed` and 23503 `claims_coupon_id_fkey` → 404 (both via `mapPgError`); 410 `coupon-disabled` / `coupon-expired` / `coupon-sold-out` thrown by the service.

- [ ] **Step 1: Write the failing claim tests**

`test/claims.test.ts`:

```ts
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, bootTestApp, createCoupon, createUser, resetState, type TestContext, type TestUser } from './helpers.ts';

let t: TestContext;
let owner: TestUser;
let alice: TestUser;
let bob: TestUser;
before(async () => {
  t = await bootTestApp();
});
after(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetState(t);
  owner = await createUser(t);
  alice = await createUser(t);
  bob = await createUser(t);
});

async function claimRows(couponId: string) {
  return t.db.selectFrom('claims').select(['id', 'user_id']).where('coupon_id', '=', couponId).orderBy('id').execute();
}

test('claim succeeds, updates the counter, and marks claimed_by_me for the claimer only', async () => {
  const c = await createCoupon(t, owner.token, { total_quantity: 3 });
  const res = await api(t, 'POST', `/coupons/${c.id}/claims`, { token: alice.token });
  assert.equal(res.status, 201);
  assert.equal(typeof res.body.id, 'number');
  assert.equal(res.body.coupon_id, c.id);
  assert.equal(res.body.user_id, alice.id);
  assert.ok(res.body.claimed_at);
  assert.equal(res.body.remaining, 2);

  const asAlice = await api(t, 'GET', `/coupons/${c.id}`, { token: alice.token });
  assert.equal(asAlice.body.claimed_count, 1);
  assert.equal(asAlice.body.remaining, 2);
  assert.equal(asAlice.body.claimed_by_me, true);
  assert.equal(asAlice.body.version, 1, 'claims must not bump the edit version');
  const asBob = await api(t, 'GET', `/coupons/${c.id}`, { token: bob.token });
  assert.equal(asBob.body.claimed_by_me, false);
});

test('claiming the same coupon twice is a 409 and leaves exactly one row', async () => {
  const c = await createCoupon(t, owner.token, { total_quantity: 3 });
  assert.equal((await api(t, 'POST', `/coupons/${c.id}/claims`, { token: alice.token })).status, 201);
  const again = await api(t, 'POST', `/coupons/${c.id}/claims`, { token: alice.token });
  assert.equal(again.status, 409);
  assert.equal(again.body.type, '/problems/already-claimed');
  assert.equal((await claimRows(c.id)).length, 1);
  const view = await api(t, 'GET', `/coupons/${c.id}`, { token: alice.token });
  assert.equal(view.body.claimed_count, 1);
});

test('unknown coupon is a 404', async () => {
  const res = await api(t, 'POST', '/coupons/00000000-0000-4000-8000-000000000000/claims', { token: alice.token });
  assert.equal(res.status, 404);
  assert.equal(res.body.type, '/problems/not-found');
});

test('claims require authentication', async () => {
  const c = await createCoupon(t, owner.token);
  assert.equal((await api(t, 'POST', `/coupons/${c.id}/claims`)).status, 401);
});

test('disabled, expired, and sold-out coupons are 410 with distinct problem types', async () => {
  const disabled = await createCoupon(t, owner.token);
  await api(t, 'PATCH', `/coupons/${disabled.id}`, { token: owner.token, body: { version: 1, status: 'disabled' } });
  const d = await api(t, 'POST', `/coupons/${disabled.id}/claims`, { token: alice.token });
  assert.equal(d.status, 410);
  assert.equal(d.body.type, '/problems/coupon-disabled');

  const expired = await createCoupon(t, owner.token, { expires_at: '2020-01-01T00:00:00Z' });
  const e = await api(t, 'POST', `/coupons/${expired.id}/claims`, { token: alice.token });
  assert.equal(e.status, 410);
  assert.equal(e.body.type, '/problems/coupon-expired');

  const one = await createCoupon(t, owner.token, { total_quantity: 1 });
  assert.equal((await api(t, 'POST', `/coupons/${one.id}/claims`, { token: bob.token })).status, 201);
  const s = await api(t, 'POST', `/coupons/${one.id}/claims`, { token: alice.token });
  assert.equal(s.status, 410);
  assert.equal(s.body.type, '/problems/coupon-sold-out');
});

test('a rejected claim leaves no claim row behind (the insert was rolled back)', async () => {
  const one = await createCoupon(t, owner.token, { total_quantity: 1 });
  await api(t, 'POST', `/coupons/${one.id}/claims`, { token: bob.token });
  await api(t, 'POST', `/coupons/${one.id}/claims`, { token: alice.token });
  const rows = await claimRows(one.id);
  assert.deepEqual(rows.map((r) => r.user_id), [bob.id]);
  const asAlice = await api(t, 'GET', `/coupons/${one.id}`, { token: alice.token });
  assert.equal(asAlice.body.claimed_by_me, false);
  assert.equal(asAlice.body.claimed_count, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --env-file=.env.test --test test/claims.test.ts`
Expected: FAIL with 404 on the claims route.

- [ ] **Step 3: Append claimCoupon to src/coupons/service.ts**

```ts
export interface ClaimResult {
  id: number;
  coupon_id: string;
  user_id: string;
  claimed_at: Date;
  remaining: number;
}

/**
 * The consistency core. Two statements, one short transaction, READ COMMITTED, no explicit locks.
 *
 *  1. INSERT the claim first. A duplicate dies on the unique index (23505 → 409) without ever
 *     touching the contended coupon row. A bad coupon id dies on the FK (23503 → 404).
 *  2. Conditional UPDATE. Postgres takes the row lock inside the UPDATE and re-evaluates the WHERE
 *     against the newest committed row after any concurrent writer finishes, so the increment is
 *     a true compare-and-swap: N racing claims on Q units yield exactly Q successes.
 *     Zero rows means the predicate failed; we read the row once to say why, then the throw rolls
 *     the INSERT back.
 *
 * Deadlock-free: every claim touches its own new claims row, then one coupon row. The FK check
 * takes FOR KEY SHARE on the coupon; the UPDATE of non-key columns takes FOR NO KEY UPDATE, which
 * is compatible with it. Claims on the same coupon simply queue.
 *
 * Even if this code were wrong, `coupons_claimed_within_total` (CHECK) would refuse to oversell.
 */
export async function claimCoupon(db: Db, couponId: string, userId: string): Promise<ClaimResult> {
  return db.transaction().execute(async (trx) => {
    const claim = await trx
      .insertInto('claims')
      .values({ coupon_id: couponId, user_id: userId })
      .returning(['id', 'coupon_id', 'user_id', 'claimed_at'])
      .executeTakeFirstOrThrow();

    const { rows } = await sql<{ claimed_count: number; total_quantity: number }>`
      UPDATE coupons
         SET claimed_count = claimed_count + 1,
             updated_at    = now()
       WHERE id = ${couponId}
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at > now())
         AND claimed_count < total_quantity
      RETURNING claimed_count, total_quantity
    `.execute(trx);

    const updated = rows[0];
    if (!updated) {
      // The FK check above proved the coupon exists, so this read cannot miss.
      const c = await trx.selectFrom('coupons').select(['code', 'status', 'expires_at']).where('id', '=', couponId).executeTakeFirstOrThrow();
      const [slug, title, why] =
        c.status !== 'active'
          ? ['coupon-disabled', 'Coupon disabled', 'it has been disabled by its owner']
          : c.expires_at && c.expires_at.getTime() <= Date.now()
            ? ['coupon-expired', 'Coupon expired', 'it has expired']
            : ['coupon-sold-out', 'Coupon sold out', 'all units have been claimed'];
      throw new HttpProblem(410, slug, title, `Coupon ${c.code} cannot be claimed: ${why}.`);
    }
    return { ...claim, remaining: updated.total_quantity - updated.claimed_count };
  });
}
```

- [ ] **Step 4: Add the route to src/coupons/routes.ts**

Add `claimCoupon` to the service import. Replace the `// POST  /coupons/:id/claims     (Task 8)` comment with:

```ts
  app.post('/coupons/:id/claims', auth, async (req, res) => {
    const id = parseId(req.params.id);
    const claim = await claimCoupon(ctx.db, id, req.user!.id);
    await ctx.cache.del(STATS_CACHE_KEY);
    res.status(201).json(claim);
  });
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `node --env-file=.env.test --test test/claims.test.ts && npm run typecheck`
Expected: 6 passing, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/coupons test/claims.test.ts
git commit -m "feat(claims): insert-then-conditional-update claim transaction"
```

---

### Task 9: Concurrency proofs

**Files:**
- Test: `test/concurrency.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5–8 via HTTP; `createUsers` from the helpers.

- [ ] **Step 1: Write the concurrency tests**

`test/concurrency.test.ts`:

```ts
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, bootTestApp, createCoupon, createUser, createUsers, resetState, type ApiResponse, type TestContext, type TestUser } from './helpers.ts';

let t: TestContext;
let owner: TestUser;
before(async () => {
  t = await bootTestApp();
});
after(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetState(t);
  owner = await createUser(t);
});

function tally(results: ApiResponse[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of results) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}

async function counterAndRows(couponId: string) {
  const coupon = await t.db.selectFrom('coupons').select(['claimed_count', 'total_quantity', 'version']).where('id', '=', couponId).executeTakeFirstOrThrow();
  const { n } = await t.db
    .selectFrom('claims')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('coupon_id', '=', couponId)
    .executeTakeFirstOrThrow();
  return { ...coupon, rows: Number(n) };
}

test('500 users racing for 50 units: exactly 50 succeed and the counter equals the row count', async () => {
  const coupon = await createCoupon(t, owner.token, { total_quantity: 50 });
  const users = await createUsers(t, 500);

  const results = await Promise.all(users.map((u) => api(t, 'POST', `/coupons/${coupon.id}/claims`, { token: u.token })));

  const byStatus = tally(results);
  assert.deepEqual(byStatus, { 201: 50, 410: 450 }, JSON.stringify(byStatus));
  for (const r of results.filter((r) => r.status === 410)) assert.equal(r.body.type, '/problems/coupon-sold-out');

  const state = await counterAndRows(coupon.id);
  assert.equal(state.claimed_count, 50);
  assert.equal(state.rows, 50);
  assert.equal(state.total_quantity, 50);

  const view = await api(t, 'GET', `/coupons/${coupon.id}`, { token: owner.token });
  assert.equal(view.body.remaining, 0);
  const winners = new Set(results.filter((r) => r.status === 201).map((r) => r.body.user_id));
  assert.equal(winners.size, 50, 'each success belongs to a distinct user');
});

test('one user firing 100 parallel claims lands exactly one', async () => {
  const coupon = await createCoupon(t, owner.token, { total_quantity: 1000 });
  const [alice] = await createUsers(t, 1);

  const results = await Promise.all(Array.from({ length: 100 }, () => api(t, 'POST', `/coupons/${coupon.id}/claims`, { token: alice!.token })));

  assert.deepEqual(tally(results), { 201: 1, 409: 99 });
  const state = await counterAndRows(coupon.id);
  assert.equal(state.claimed_count, 1);
  assert.equal(state.rows, 1);
});

test('20 concurrent edits with the same version: exactly one wins', async () => {
  const coupon = await createCoupon(t, owner.token);

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => api(t, 'PATCH', `/coupons/${coupon.id}`, { token: owner.token, body: { version: 1, title: `edit ${i}` } })),
  );

  assert.deepEqual(tally(results), { 200: 1, 409: 19 });
  const state = await counterAndRows(coupon.id);
  assert.equal(state.version, 2);
  const winner = results.find((r) => r.status === 200)!;
  const view = await api(t, 'GET', `/coupons/${coupon.id}`, { token: owner.token });
  assert.equal(view.body.title, winner.body.title);
});

test('mixed claims and edits on one coupon: no 500s and the invariant holds', async () => {
  const coupon = await createCoupon(t, owner.token, { total_quantity: 30 });
  const users = await createUsers(t, 50);

  const claims = users.map((u) => api(t, 'POST', `/coupons/${coupon.id}/claims`, { token: u.token }));
  const edits = Array.from({ length: 10 }, (_, i) => api(t, 'PATCH', `/coupons/${coupon.id}`, { token: owner.token, body: { version: 1, title: `t${i}` } }));
  const results = await Promise.all([...claims, ...edits]);

  const byStatus = tally(results);
  assert.equal(byStatus[500] ?? 0, 0, JSON.stringify(byStatus));
  assert.equal(byStatus[201], 30);
  assert.equal(byStatus[410], 20);
  assert.equal(byStatus[200], 1);
  assert.equal(byStatus[409], 9);

  const state = await counterAndRows(coupon.id);
  assert.equal(state.claimed_count, 30);
  assert.equal(state.rows, 30);
  assert.equal(state.version, 2);
});
```

- [ ] **Step 2: Run the tests**

Run: `node --env-file=.env.test --test test/concurrency.test.ts`
Expected: 4 passing. If the first test is slow (more than ~10s), raise `PG_POOL_MAX` in `.env.test` to 20; it is already 20. The whole file should finish in a few seconds.

- [ ] **Step 3: Run the full suite and record the output for the README**

Run: `npm test 2>&1 | tee /tmp/test-output.txt`
Expected: all passing. Keep `/tmp/test-output.txt`; Task 15 pastes the concurrency section into the README.

- [ ] **Step 4: Commit**

```bash
git add test/concurrency.test.ts
git commit -m "test: concurrency proofs for oversell, duplicate, and edit races"
```

---

### Task 10: Stats aggregate with Redis cache and invalidation, fail-open proof

**Files:**
- Modify: `src/coupons/service.ts` (append `couponStats`), `src/coupons/routes.ts` (add `GET /coupons/stats`), `test/helpers.ts` (fail-open boot option)
- Test: `test/stats.test.ts`

**Interfaces:**
- Produces: `interface Stats { total_coupons; active_coupons; total_units; claimed_units; remaining_units; total_claims; unique_claimers; generated_at: string }`, `couponStats(db): Promise<Stats>`. `bootTestApp(overrides, { awaitRedis?: boolean })`.

- [ ] **Step 1: Write the failing stats tests**

`test/stats.test.ts`:

```ts
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, bootTestApp, createCoupon, createUser, createUsers, resetState, TEST_PASSWORD, type TestContext, type TestUser } from './helpers.ts';

let t: TestContext;
let owner: TestUser;
before(async () => {
  t = await bootTestApp();
});
after(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetState(t);
  owner = await createUser(t);
});

test('stats aggregate the pool and expose both counter and row count', async () => {
  const a = await createCoupon(t, owner.token, { total_quantity: 10 });
  const b = await createCoupon(t, owner.token, { total_quantity: 5 });
  await api(t, 'PATCH', `/coupons/${b.id}`, { token: owner.token, body: { version: 1, status: 'disabled' } });
  const [u1, u2, u3] = await createUsers(t, 3);
  await api(t, 'POST', `/coupons/${a.id}/claims`, { token: u1!.token });
  await api(t, 'POST', `/coupons/${a.id}/claims`, { token: u2!.token });
  await api(t, 'POST', `/coupons/${a.id}/claims`, { token: u3!.token });

  const res = await api(t, 'GET', '/coupons/stats', { token: owner.token });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-cache'), 'MISS');
  const { generated_at, ...numbers } = res.body;
  assert.ok(generated_at);
  assert.deepEqual(numbers, {
    total_coupons: 2,
    active_coupons: 1,
    total_units: 15,
    claimed_units: 3,
    remaining_units: 12,
    total_claims: 3,
    unique_claimers: 3,
  });
});

test('stats are served from cache and invalidated by every write', async () => {
  const a = await createCoupon(t, owner.token, { total_quantity: 10 });
  const [u1] = await createUsers(t, 1);

  const miss = await api(t, 'GET', '/coupons/stats', { token: owner.token });
  assert.equal(miss.headers.get('x-cache'), 'MISS');
  const hit = await api(t, 'GET', '/coupons/stats', { token: owner.token });
  assert.equal(hit.headers.get('x-cache'), 'HIT');
  assert.deepEqual(hit.body, miss.body);

  await api(t, 'POST', `/coupons/${a.id}/claims`, { token: u1!.token });
  const afterClaim = await api(t, 'GET', '/coupons/stats', { token: owner.token });
  assert.equal(afterClaim.headers.get('x-cache'), 'MISS');
  assert.equal(afterClaim.body.claimed_units, 1);
  assert.equal(afterClaim.body.total_claims, 1);

  await createCoupon(t, owner.token);
  assert.equal((await api(t, 'GET', '/coupons/stats', { token: owner.token })).headers.get('x-cache'), 'MISS');
  assert.equal((await api(t, 'GET', '/coupons/stats', { token: owner.token })).headers.get('x-cache'), 'HIT');

  await api(t, 'PATCH', `/coupons/${a.id}`, { token: owner.token, body: { version: 1, total_quantity: 20 } });
  const afterPatch = await api(t, 'GET', '/coupons/stats', { token: owner.token });
  assert.equal(afterPatch.headers.get('x-cache'), 'MISS');
  assert.equal(afterPatch.body.total_units, 30);
});

test('stats require authentication', async () => {
  assert.equal((await api(t, 'GET', '/coupons/stats')).status, 401);
});

test('with Redis unreachable the API degrades instead of failing', async () => {
  const dead = await bootTestApp({ REDIS_URL: 'redis://127.0.0.1:1/0' }, { awaitRedis: false });
  try {
    const health = await api(dead, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { status: 'degraded', checks: { postgres: 'ok', redis: 'fail' } });

    const user = await createUser(dead);
    const stats = await api(dead, 'GET', '/coupons/stats', { token: user.token });
    assert.equal(stats.status, 200);
    assert.equal(stats.headers.get('x-cache'), 'MISS');

    const login = await api(dead, 'POST', '/auth/login', { body: { email: user.email, password: TEST_PASSWORD } });
    assert.equal(login.status, 200, 'rate limiter must fail open');
  } finally {
    await dead.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --env-file=.env.test --test test/stats.test.ts`
Expected: FAIL. `/coupons/stats` currently matches `/coupons/:id` and returns 404 (`stats` is not a UUID); the fail-open test fails because `bootTestApp` does not accept a second argument.

- [ ] **Step 3: Update test/helpers.ts for the fail-open boot**

Replace the `bootTestApp` signature and the Redis connect line:

```ts
export async function bootTestApp(overrides: Partial<Config> = {}, opts: { awaitRedis?: boolean } = {}): Promise<TestContext> {
```

Replace `await redis.connect();` with:

```ts
  if (opts.awaitRedis === false) {
    // Mirrors server.ts: start without Redis and let the client retry in the background.
    redis.connect().catch(() => {});
  } else {
    await redis.connect();
  }
```

In `close()`, replace `redis.destroy();` with:

```ts
      try {
        redis.destroy();
      } catch {
        // never connected
      }
```

In `resetState`, replace `await t.redis.flushDb();` with:

```ts
  await t.redis.flushDb().catch(() => {
    // Redis intentionally unreachable in the fail-open test.
  });
```

- [ ] **Step 4: Append couponStats to src/coupons/service.ts**

```ts
export interface Stats {
  total_coupons: number;
  active_coupons: number;
  total_units: number;
  claimed_units: number;
  remaining_units: number;
  total_claims: number;
  unique_claimers: number;
  generated_at: string;
}

/**
 * claimed_units (SUM of the denormalised counter) and total_claims (COUNT of claim rows) come from
 * different tables and must always be equal. Exposing both makes the consistency guarantee visible.
 */
export async function couponStats(db: Db): Promise<Stats> {
  const { rows } = await sql<Omit<Stats, 'generated_at'>>`
    WITH c AS (
      SELECT count(*)::int                                   AS total_coupons,
             count(*) FILTER (WHERE status = 'active')::int  AS active_coupons,
             coalesce(sum(total_quantity), 0)::bigint        AS total_units,
             coalesce(sum(claimed_count), 0)::bigint         AS claimed_units
        FROM coupons
    ), k AS (
      SELECT count(*)::bigint               AS total_claims,
             count(DISTINCT user_id)::int   AS unique_claimers
        FROM claims
    )
    SELECT c.total_coupons, c.active_coupons, c.total_units, c.claimed_units,
           (c.total_units - c.claimed_units)::bigint AS remaining_units,
           k.total_claims, k.unique_claimers
      FROM c, k
  `.execute(db);
  return { ...rows[0]!, generated_at: new Date().toISOString() };
}
```

- [ ] **Step 5: Add the stats route to src/coupons/routes.ts**

Add `couponStats` to the service import. Replace the `// GET /coupons/stats is registered here in Task 10 and MUST come before /coupons/:id.` comment with:

```ts
  // Must be registered before /coupons/:id or Express would treat "stats" as an id.
  app.get('/coupons/stats', auth, async (_req, res) => {
    const cached = await ctx.cache.get(STATS_CACHE_KEY);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      res.type('application/json').send(cached);
      return;
    }
    // Read-only aggregate, allowed to be STATS_CACHE_TTL_SECONDS stale. Every write path DELs the key.
    const body = JSON.stringify(await couponStats(ctx.db));
    await ctx.cache.set(STATS_CACHE_KEY, body, ctx.config.STATS_CACHE_TTL_SECONDS);
    res.setHeader('X-Cache', 'MISS');
    res.type('application/json').send(body);
  });
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `node --env-file=.env.test --test test/stats.test.ts && npm run typecheck`
Expected: 4 passing, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/coupons test/helpers.ts test/stats.test.ts
git commit -m "feat(stats): pool aggregate with fail-open redis cache and write invalidation"
```

---

### Task 11: User claim history — GET /me/claims

**Files:**
- Create: `src/claims/routes.ts`
- Modify: `src/coupons/service.ts` (append `listUserClaims`), `src/app.ts`
- Test: `test/history.test.ts`

**Interfaces:**
- Produces: `interface ClaimHistoryRow { id: number; claimed_at: Date; coupon: { id: string; code: string; title: string; status: CouponStatus; expires_at: Date | null } }`, `interface HistoryFilters { from?: string; to?: string; coupon_status?: CouponStatus; limit: number; cursor?: string }`, `listUserClaims(db, userId, f: HistoryFilters): Promise<Page<ClaimHistoryRow>>`, `registerClaimRoutes(app, ctx)`.

- [ ] **Step 1: Write the failing history tests**

`test/history.test.ts`:

```ts
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, bootTestApp, createCoupon, createUser, resetState, type TestContext, type TestUser } from './helpers.ts';

let t: TestContext;
let owner: TestUser;
let alice: TestUser;
let bob: TestUser;
before(async () => {
  t = await bootTestApp();
});
after(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetState(t);
  owner = await createUser(t);
  alice = await createUser(t);
  bob = await createUser(t);
});

async function seedHistory() {
  const c1 = await createCoupon(t, owner.token, { code: 'H-1', title: 'First' });
  const c2 = await createCoupon(t, owner.token, { code: 'H-2', title: 'Second' });
  const c3 = await createCoupon(t, owner.token, { code: 'H-3', title: 'Third' });
  const claim1 = (await api(t, 'POST', `/coupons/${c1.id}/claims`, { token: alice.token })).body;
  await api(t, 'POST', `/coupons/${c2.id}/claims`, { token: alice.token });
  await api(t, 'POST', `/coupons/${c3.id}/claims`, { token: alice.token });
  await api(t, 'POST', `/coupons/${c1.id}/claims`, { token: bob.token });
  // Back-date Alice's first claim so the date filters have something to bite on.
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  await t.db.updateTable('claims').set({ claimed_at: twoDaysAgo }).where('id', '=', claim1.id).execute();
  await api(t, 'PATCH', `/coupons/${c3.id}`, { token: owner.token, body: { version: 1, status: 'disabled' } });
  return { c1, c2, c3 };
}

test('history returns only the caller’s claims, newest first, with joined coupon fields', async () => {
  const { c1, c3 } = await seedHistory();
  const res = await api(t, 'GET', '/me/claims', { token: alice.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 3);
  assert.equal(res.body.next_cursor, null);
  assert.deepEqual(res.body.data.map((r: { coupon: { code: string } }) => r.coupon.code), ['H-3', 'H-2', 'H-1']);
  const newest = res.body.data[0];
  assert.equal(typeof newest.id, 'number');
  assert.ok(newest.claimed_at);
  assert.deepEqual(newest.coupon, { id: c3.id, code: 'H-3', title: 'Third', status: 'disabled', expires_at: null });
  assert.equal(res.body.data[2].coupon.id, c1.id);

  const bobs = await api(t, 'GET', '/me/claims', { token: bob.token });
  assert.deepEqual(bobs.body.data.map((r: { coupon: { code: string } }) => r.coupon.code), ['H-1']);
});

test('history filters by date range and coupon status', async () => {
  await seedHistory();
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const recent = await api(t, 'GET', `/me/claims?from=${encodeURIComponent(yesterday)}`, { token: alice.token });
  assert.deepEqual(recent.body.data.map((r: { coupon: { code: string } }) => r.coupon.code), ['H-3', 'H-2']);
  const old = await api(t, 'GET', `/me/claims?to=${encodeURIComponent(yesterday)}`, { token: alice.token });
  assert.deepEqual(old.body.data.map((r: { coupon: { code: string } }) => r.coupon.code), ['H-1']);
  const disabled = await api(t, 'GET', '/me/claims?coupon_status=disabled', { token: alice.token });
  assert.deepEqual(disabled.body.data.map((r: { coupon: { code: string } }) => r.coupon.code), ['H-3']);
  const bad = await api(t, 'GET', '/me/claims?from=yesterday', { token: alice.token });
  assert.equal(bad.status, 400);
});

test('history paginates by claim id with an opaque cursor', async () => {
  await seedHistory();
  const p1 = await api(t, 'GET', '/me/claims?limit=2', { token: alice.token });
  assert.equal(p1.body.data.length, 2);
  assert.ok(p1.body.next_cursor);
  const p2 = await api(t, 'GET', `/me/claims?limit=2&cursor=${encodeURIComponent(p1.body.next_cursor)}`, { token: alice.token });
  assert.equal(p2.body.data.length, 1);
  assert.equal(p2.body.next_cursor, null);
  const ids = [...p1.body.data, ...p2.body.data].map((r: { id: number }) => r.id);
  assert.deepEqual([...ids].sort((a, b) => b - a), ids, 'strictly descending ids across pages');
  assert.equal(new Set(ids).size, 3);
});

test('history requires authentication and is empty for a fresh user', async () => {
  assert.equal((await api(t, 'GET', '/me/claims')).status, 401);
  const res = await api(t, 'GET', '/me/claims', { token: alice.token });
  assert.deepEqual(res.body, { data: [], next_cursor: null });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --env-file=.env.test --test test/history.test.ts`
Expected: FAIL with 404 on `/me/claims`.

- [ ] **Step 3: Append listUserClaims to src/coupons/service.ts**

Add `decodeIntCursor` to the pagination import at the top of the file:

```ts
import { decodeIntCursor, decodeStringCursor, page, type Page } from '../lib/pagination.ts';
```

Append:

```ts
export interface ClaimHistoryRow {
  id: number;
  claimed_at: Date;
  coupon: { id: string; code: string; title: string; status: CouponStatus; expires_at: Date | null };
}

export interface HistoryFilters {
  from?: string;
  to?: string;
  coupon_status?: CouponStatus;
  limit: number;
  cursor?: string;
}

/** claims ⋈ coupons for one user, keyset-paginated on claims.id via index claims_user_id_id_idx. */
export async function listUserClaims(db: Db, userId: string, f: HistoryFilters): Promise<Page<ClaimHistoryRow>> {
  let q = db
    .selectFrom('claims as cl')
    .innerJoin('coupons as c', 'c.id', 'cl.coupon_id')
    .select(['cl.id', 'cl.claimed_at', 'c.id as coupon_id', 'c.code', 'c.title', 'c.status', 'c.expires_at'])
    .where('cl.user_id', '=', userId);
  if (f.from) q = q.where('cl.claimed_at', '>=', new Date(f.from));
  if (f.to) q = q.where('cl.claimed_at', '<', new Date(f.to));
  if (f.coupon_status) q = q.where('c.status', '=', f.coupon_status);
  if (f.cursor) q = q.where('cl.id', '<', decodeIntCursor(f.cursor));
  const rows = await q.orderBy('cl.id', 'desc').limit(f.limit + 1).execute();
  const shaped: ClaimHistoryRow[] = rows.map((r) => ({
    id: r.id,
    claimed_at: r.claimed_at,
    coupon: { id: r.coupon_id, code: r.code, title: r.title, status: r.status, expires_at: r.expires_at },
  }));
  return page(shaped, f.limit, (r) => r.id);
}
```

- [ ] **Step 4: Create src/claims/routes.ts**

```ts
import type { Express } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import { requireAuth } from '../auth/middleware.ts';
import { listUserClaims } from '../coupons/service.ts';
import { pageQuery } from '../lib/pagination.ts';
import { parse } from '../lib/validate.ts';

const historyQuery = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  coupon_status: z.enum(['active', 'disabled']).optional(),
  ...pageQuery,
});

export function registerClaimRoutes(app: Express, ctx: AppContext): void {
  app.get('/me/claims', requireAuth(ctx.tokens), async (req, res) => {
    const filters = parse(historyQuery, req.query);
    res.json(await listUserClaims(ctx.db, req.user!.id, filters));
  });
}
```

- [ ] **Step 5: Register in src/app.ts**

Add the import:

```ts
import { registerClaimRoutes } from './claims/routes.ts';
```

Replace the `// registerClaimRoutes(app, ctx)   (Task 11)` comment with `registerClaimRoutes(app, ctx);`.

- [ ] **Step 6: Run the tests and typecheck**

Run: `node --env-file=.env.test --test test/history.test.ts && npm run typecheck && npm test`
Expected: 4 passing in the file; full suite green.

- [ ] **Step 7: Capture the EXPLAIN plans for the README**

With the dev database seeded and at least one claim present (create one through the API or run the k6 fixtures in Task 14 first), run:

```bash
docker-compose exec -T postgres psql -U luarc -d luarc -c "EXPLAIN (ANALYZE, BUFFERS) SELECT cl.id, cl.claimed_at, c.id, c.code, c.title, c.status, c.expires_at FROM claims cl JOIN coupons c ON c.id = cl.coupon_id WHERE cl.user_id = (SELECT id FROM users LIMIT 1) AND cl.id < 1000000 ORDER BY cl.id DESC LIMIT 21;" | tee /tmp/explain-history.txt
docker-compose exec -T postgres psql -U luarc -d luarc -c "EXPLAIN (ANALYZE, BUFFERS) SELECT c.*, (c.total_quantity - c.claimed_count) AS remaining, (mine.id IS NOT NULL) AS claimed_by_me FROM coupons c LEFT JOIN claims mine ON mine.coupon_id = c.id AND mine.user_id = (SELECT id FROM users LIMIT 1) WHERE c.status = 'active' ORDER BY c.code ASC LIMIT 21;" | tee /tmp/explain-pool.txt
```

Expected: the history plan shows `Index Scan Backward using claims_user_id_id_idx`; the pool plan shows `Index Scan using coupons_status_code_idx` (on a tiny table Postgres may pick a Seq Scan; if so, run `SET enable_seqscan = off;` in the same session before EXPLAIN to show the index is usable, and say so in the README).

- [ ] **Step 8: Commit**

```bash
git add src/claims src/coupons/service.ts src/app.ts test/history.test.ts
git commit -m "feat(history): user claim history with joins, filters, keyset pagination"
```

---

### Task 12: OpenAPI document, Swagger UI, and route-coverage contract test

**Files:**
- Create: `openapi.yaml`, `src/docs.ts`
- Modify: `src/app.ts`
- Test: `test/openapi.test.ts`

**Interfaces:**
- Produces: `registerDocs(app: Express): void` serving `GET /openapi.yaml` and Swagger UI at `/docs`.

- [ ] **Step 1: Write the failing contract test**

`test/openapi.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createDb } from '../src/db/index.ts';
import { createRedis } from '../src/lib/redis.ts';

/** Every route registered on the Express app must be documented. Minimal YAML walk; we control the file's shape. */
function documentedOperations(yaml: string): Set<string> {
  const ops = new Set<string>();
  let currentPath: string | null = null;
  let inPaths = false;
  for (const line of yaml.split('\n')) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (inPaths && /^\S/.test(line)) inPaths = false;
    if (!inPaths) continue;
    const p = line.match(/^  (\/\S*):\s*$/);
    if (p) {
      currentPath = p[1]!;
      continue;
    }
    const m = line.match(/^    (get|post|put|patch|delete):\s*$/);
    if (m && currentPath) ops.add(`${m[1]!.toUpperCase()} ${currentPath}`);
  }
  return ops;
}

function registeredOperations(): Set<string> {
  const config = loadConfig();
  const logger = pino({ level: 'silent' });
  const db = createDb(config.DATABASE_URL, 1);
  const redis = createRedis(config.REDIS_URL, logger);
  const { app } = createApp({ config, db, redis, logger });
  const ops = new Set<string>();
  type Layer = { route?: { path: string; methods: Record<string, boolean> } };
  const stack = (app as unknown as { router: { stack: Layer[] } }).router.stack;
  for (const layer of stack) {
    if (!layer.route) continue;
    const oaPath = layer.route.path.replace(/:([A-Za-z_]+)/g, '{$1}');
    for (const method of Object.keys(layer.route.methods)) ops.add(`${method.toUpperCase()} ${oaPath}`);
  }
  void db.destroy();
  return ops;
}

test('every Express route is documented in openapi.yaml', () => {
  const yaml = readFileSync(path.join(import.meta.dirname, '..', 'openapi.yaml'), 'utf8');
  const documented = documentedOperations(yaml);
  const registered = registeredOperations();
  registered.delete('GET /openapi.yaml');
  const missing = [...registered].filter((op) => !documented.has(op)).sort();
  assert.deepEqual(missing, [], `undocumented routes: ${missing.join(', ')}`);
  const stale = [...documented].filter((op) => !registered.has(op)).sort();
  assert.deepEqual(stale, [], `documented but not registered: ${stale.join(', ')}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --env-file=.env.test --test test/openapi.test.ts`
Expected: FAIL, `openapi.yaml` not found.

- [ ] **Step 3: Create openapi.yaml**

```yaml
openapi: 3.1.0
info:
  title: Luarc Asset Management API
  version: 1.0.0
  description: |
    Authenticated coupon/voucher pool that stays consistent under concurrent claims and edits.

    **Consistency model.** Claiming is a single transaction: insert the claim row (unique per user and coupon),
    then a conditional `UPDATE ... WHERE claimed_count < total_quantity`. Postgres row locking makes the
    increment a compare-and-swap, and a CHECK constraint makes overselling structurally impossible.
    Editing a coupon uses optimistic locking: send the `version` you last saw; a stale version is a 409.

    **Errors** are RFC 9457 problem details (`application/problem+json`) with `type: /problems/<slug>` and a
    `request_id` you can quote when reporting an issue.
servers:
  - url: http://localhost:3000
tags:
  - name: Auth
  - name: Coupons
  - name: Claims
  - name: Ops
security:
  - bearerAuth: []
paths:
  /auth/register:
    post:
      tags: [Auth]
      security: []
      summary: Create an account and receive a token pair
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Credentials' }
      responses:
        '201':
          description: Account created
          content:
            application/json:
              schema: { $ref: '#/components/schemas/AuthResponse' }
        '400': { $ref: '#/components/responses/ValidationError' }
        '409':
          description: Email already registered (`/problems/email-taken`)
          content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' } } }
        '429': { $ref: '#/components/responses/RateLimited' }
  /auth/login:
    post:
      tags: [Auth]
      security: []
      summary: Exchange credentials for a token pair
      description: Unknown email and wrong password return the same body and take the same code path.
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Credentials' }
      responses:
        '200':
          description: Authenticated
          content:
            application/json:
              schema: { $ref: '#/components/schemas/AuthResponse' }
        '400': { $ref: '#/components/responses/ValidationError' }
        '401':
          description: Invalid credentials (`/problems/invalid-credentials`)
          content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' } } }
        '429': { $ref: '#/components/responses/RateLimited' }
  /auth/refresh:
    post:
      tags: [Auth]
      security: []
      summary: Rotate a refresh token
      description: |
        The presented token is revoked and a new pair is issued. Presenting an already-rotated token is
        treated as theft: every live refresh token for that user is revoked.
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/RefreshRequest' }
      responses:
        '200':
          description: New token pair
          content:
            application/json:
              schema: { $ref: '#/components/schemas/TokenPair' }
        '400': { $ref: '#/components/responses/ValidationError' }
        '401':
          description: Unknown, expired, or revoked token (`/problems/invalid-refresh-token`)
          content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' } } }
        '429': { $ref: '#/components/responses/RateLimited' }
  /auth/logout:
    post:
      tags: [Auth]
      security: []
      summary: Revoke a refresh token
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/RefreshRequest' }
      responses:
        '204': { description: Revoked (also returned for unknown tokens) }
        '400': { $ref: '#/components/responses/ValidationError' }
        '429': { $ref: '#/components/responses/RateLimited' }
  /me:
    get:
      tags: [Auth]
      summary: The authenticated user
      responses:
        '200':
          description: Current user
          content:
            application/json:
              schema: { $ref: '#/components/schemas/User' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '404': { $ref: '#/components/responses/NotFound' }
  /me/claims:
    get:
      tags: [Claims]
      summary: The caller's claim history (claims joined to coupons)
      parameters:
        - { name: from, in: query, schema: { type: string, format: date-time }, description: Inclusive lower bound on claimed_at }
        - { name: to, in: query, schema: { type: string, format: date-time }, description: Exclusive upper bound on claimed_at }
        - { name: coupon_status, in: query, schema: { $ref: '#/components/schemas/CouponStatus' } }
        - { $ref: '#/components/parameters/Limit' }
        - { $ref: '#/components/parameters/Cursor' }
      responses:
        '200':
          description: Newest first, keyset-paginated on claim id
          content:
            application/json:
              schema:
                type: object
                required: [data, next_cursor]
                properties:
                  data: { type: array, items: { $ref: '#/components/schemas/ClaimHistoryRow' } }
                  next_cursor: { type: [string, 'null'] }
        '400': { $ref: '#/components/responses/ValidationError' }
        '401': { $ref: '#/components/responses/Unauthorized' }
  /coupons:
    post:
      tags: [Coupons]
      summary: Create a coupon
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/CouponCreate' }
      responses:
        '201':
          description: Created; `Location` header points at the coupon
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Coupon' }
        '400': { $ref: '#/components/responses/ValidationError' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '409':
          description: Code already exists (`/problems/code-taken`)
          content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' } } }
    get:
      tags: [Coupons]
      summary: The global pool with per-coupon state
      parameters:
        - { name: status, in: query, schema: { $ref: '#/components/schemas/CouponStatus' } }
        - { name: available, in: query, schema: { type: boolean }, description: Only active, unexpired coupons with remaining > 0 }
        - { name: q, in: query, schema: { type: string, maxLength: 64 }, description: Case-insensitive substring of code or title }
        - { $ref: '#/components/parameters/Limit' }
        - { $ref: '#/components/parameters/Cursor' }
      responses:
        '200':
          description: Ordered by code, keyset-paginated
          content:
            application/json:
              schema:
                type: object
                required: [data, next_cursor]
                properties:
                  data: { type: array, items: { $ref: '#/components/schemas/Coupon' } }
                  next_cursor: { type: [string, 'null'] }
        '400': { $ref: '#/components/responses/ValidationError' }
        '401': { $ref: '#/components/responses/Unauthorized' }
  /coupons/stats:
    get:
      tags: [Coupons]
      summary: Aggregate pool statistics
      description: |
        Served from Redis for up to `STATS_CACHE_TTL_SECONDS` (default 5) and invalidated on every write.
        `X-Cache: HIT|MISS` says which. `claimed_units` (sum of counters) and `total_claims` (count of rows)
        are computed from different tables and are always equal.
      responses:
        '200':
          description: Statistics
          headers:
            X-Cache: { schema: { type: string, enum: [HIT, MISS] } }
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Stats' }
        '401': { $ref: '#/components/responses/Unauthorized' }
  /coupons/{id}:
    parameters:
      - { $ref: '#/components/parameters/CouponId' }
    get:
      tags: [Coupons]
      summary: One coupon with the caller's claim status
      responses:
        '200':
          description: Coupon
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Coupon' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '404': { $ref: '#/components/responses/NotFound' }
    patch:
      tags: [Coupons]
      summary: Edit a coupon (owner only, optimistic locking)
      description: |
        Send the `version` you last read. If the coupon was edited since, you get 409 with `current_version`.
        Claims never change `version`, so editing a busy coupon is not livelocked by the counter.
        Shrinking `total_quantity` below `claimed_count` is refused by a database CHECK constraint (422).
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/CouponPatch' }
      responses:
        '200':
          description: Updated coupon with the new version
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Coupon' }
        '400': { $ref: '#/components/responses/ValidationError' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '403':
          description: Not the owner (`/problems/forbidden`)
          content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' } } }
        '404': { $ref: '#/components/responses/NotFound' }
        '409':
          description: Stale version (`/problems/version-conflict`, includes `current_version`)
          content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' } } }
        '422':
          description: total_quantity below claimed_count (`/problems/quantity-below-claimed`)
          content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' } } }
  /coupons/{id}/claims:
    parameters:
      - { $ref: '#/components/parameters/CouponId' }
    post:
      tags: [Claims]
      summary: Claim one unit of a coupon
      description: |
        Atomic under any level of concurrency: N users racing for Q units get exactly Q 201s.
        One claim per user per coupon; a repeat is a 409 and is safe to retry.
      responses:
        '201':
          description: Claimed
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ClaimResult' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '404': { $ref: '#/components/responses/NotFound' }
        '409':
          description: Already claimed by this user (`/problems/already-claimed`)
          content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' } } }
        '410':
          description: Unavailable — `/problems/coupon-sold-out`, `/problems/coupon-expired`, or `/problems/coupon-disabled`
          content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' } } }
  /health:
    get:
      tags: [Ops]
      security: []
      summary: Liveness and dependency checks
      responses:
        '200':
          description: Postgres reachable (Redis may be `fail`, in which case status is `degraded`)
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Health' }
        '503':
          description: Postgres unreachable
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Health' }
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
  parameters:
    CouponId:
      name: id
      in: path
      required: true
      schema: { type: string, format: uuid }
    Limit:
      name: limit
      in: query
      schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
    Cursor:
      name: cursor
      in: query
      schema: { type: string }
      description: Opaque cursor from a previous response's `next_cursor`
  responses:
    ValidationError:
      description: Invalid input (`/problems/validation-error`, includes `errors[]`)
      content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' } } }
    Unauthorized:
      description: Missing or invalid bearer token (`/problems/unauthorized`)
      content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' } } }
    NotFound:
      description: Not found (`/problems/not-found`)
      content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' } } }
    RateLimited:
      description: Too many requests (`/problems/rate-limited`, includes `retry_after`; `Retry-After` header set)
      content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' } } }
  schemas:
    Problem:
      type: object
      required: [type, title, status, instance, request_id]
      properties:
        type: { type: string, example: /problems/already-claimed }
        title: { type: string }
        status: { type: integer }
        detail: { type: string }
        instance: { type: string }
        request_id: { type: string }
      additionalProperties: true
    Credentials:
      type: object
      required: [email, password]
      properties:
        email: { type: string, format: email, maxLength: 254 }
        password: { type: string, minLength: 8, maxLength: 128 }
    RefreshRequest:
      type: object
      required: [refresh_token]
      properties:
        refresh_token: { type: string }
    User:
      type: object
      required: [id, email, created_at]
      properties:
        id: { type: string, format: uuid }
        email: { type: string, format: email }
        created_at: { type: string, format: date-time }
    TokenPair:
      type: object
      required: [access_token, token_type, expires_in, refresh_token]
      properties:
        access_token: { type: string, description: 'JWT (HS256). Claims: sub, email, role, aud, iss, iat, exp' }
        token_type: { type: string, enum: [Bearer] }
        expires_in: { type: integer, description: Access token lifetime in seconds }
        refresh_token: { type: string, description: Opaque; shown once, stored hashed }
    AuthResponse:
      allOf:
        - $ref: '#/components/schemas/TokenPair'
        - type: object
          required: [user]
          properties:
            user: { $ref: '#/components/schemas/User' }
    CouponStatus:
      type: string
      enum: [active, disabled]
    Coupon:
      type: object
      required: [id, code, title, description, status, total_quantity, claimed_count, remaining, expires_at, version, created_by, created_at, updated_at, claimed_by_me]
      properties:
        id: { type: string, format: uuid }
        code: { type: string, pattern: '^[A-Z0-9][A-Z0-9-]{1,31}$' }
        title: { type: string }
        description: { type: [string, 'null'] }
        status: { $ref: '#/components/schemas/CouponStatus' }
        total_quantity: { type: integer }
        claimed_count: { type: integer, description: Denormalised counter; always equals the number of claim rows }
        remaining: { type: integer, description: total_quantity - claimed_count }
        expires_at: { type: [string, 'null'], format: date-time }
        version: { type: integer, description: Increments on every edit; unchanged by claims }
        created_by: { type: string, format: uuid }
        created_at: { type: string, format: date-time }
        updated_at: { type: string, format: date-time }
        claimed_by_me: { type: boolean }
    CouponCreate:
      type: object
      required: [code, title, total_quantity]
      properties:
        code: { type: string, pattern: '^[A-Za-z0-9][A-Za-z0-9-]{1,31}$', description: Stored upper-cased; immutable }
        title: { type: string, minLength: 1, maxLength: 120 }
        description: { type: [string, 'null'], maxLength: 2000 }
        total_quantity: { type: integer, minimum: 1 }
        expires_at: { type: [string, 'null'], format: date-time }
    CouponPatch:
      type: object
      required: [version]
      description: version plus at least one editable field
      properties:
        version: { type: integer, minimum: 1 }
        title: { type: string, minLength: 1, maxLength: 120 }
        description: { type: [string, 'null'], maxLength: 2000 }
        total_quantity: { type: integer, minimum: 1 }
        status: { $ref: '#/components/schemas/CouponStatus' }
        expires_at: { type: [string, 'null'], format: date-time }
      additionalProperties: false
    ClaimResult:
      type: object
      required: [id, coupon_id, user_id, claimed_at, remaining]
      properties:
        id: { type: integer }
        coupon_id: { type: string, format: uuid }
        user_id: { type: string, format: uuid }
        claimed_at: { type: string, format: date-time }
        remaining: { type: integer }
    ClaimHistoryRow:
      type: object
      required: [id, claimed_at, coupon]
      properties:
        id: { type: integer }
        claimed_at: { type: string, format: date-time }
        coupon:
          type: object
          required: [id, code, title, status, expires_at]
          properties:
            id: { type: string, format: uuid }
            code: { type: string }
            title: { type: string }
            status: { $ref: '#/components/schemas/CouponStatus' }
            expires_at: { type: [string, 'null'], format: date-time }
    Stats:
      type: object
      required: [total_coupons, active_coupons, total_units, claimed_units, remaining_units, total_claims, unique_claimers, generated_at]
      properties:
        total_coupons: { type: integer }
        active_coupons: { type: integer }
        total_units: { type: integer }
        claimed_units: { type: integer }
        remaining_units: { type: integer }
        total_claims: { type: integer }
        unique_claimers: { type: integer }
        generated_at: { type: string, format: date-time }
    Health:
      type: object
      required: [status, checks]
      properties:
        status: { type: string, enum: [ok, degraded, fail] }
        checks:
          type: object
          properties:
            postgres: { type: string, enum: [ok, fail] }
            redis: { type: string, enum: [ok, fail] }
```

- [ ] **Step 4: Create src/docs.ts and register it**

`src/docs.ts`:

```ts
import path from 'node:path';
import type { Express } from 'express';
import swaggerUi from 'swagger-ui-express';

const specPath = path.join(import.meta.dirname, '..', 'openapi.yaml');

export function registerDocs(app: Express): void {
  app.get('/openapi.yaml', (_req, res) => {
    res.type('application/yaml').sendFile(specPath);
  });
  // Swagger UI fetches the YAML itself, so no YAML parser is needed server-side.
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(null, { swaggerOptions: { url: '/openapi.yaml' } }));
}
```

In `src/app.ts` add `import { registerDocs } from './docs.ts';` and replace the `// registerDocs(app)               (Task 12)` comment with `registerDocs(app);`.

- [ ] **Step 5: Run the tests, typecheck, and eyeball the UI**

Run: `node --env-file=.env.test --test test/openapi.test.ts && npm run typecheck`
Expected: 1 passing, typecheck clean.

```bash
npm run dev &
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/docs/
curl -s localhost:3000/openapi.yaml | head -3
kill %1
```

Expected: `200`, then the first three lines of the YAML. Open http://localhost:3000/docs in a browser once to confirm the UI renders without console CSP errors.

- [ ] **Step 6: Commit**

```bash
git add openapi.yaml src/docs.ts src/app.ts test/openapi.test.ts
git commit -m "docs: OpenAPI 3.1 contract, Swagger UI, route coverage test"
```

---

### Task 13: Dockerfile, Compose api service, GitHub Actions

**Files:**
- Create: `Dockerfile`, `.github/workflows/ci.yml`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Create the Dockerfile**

```dockerfile
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY openapi.yaml ./
USER node
EXPOSE 3000
# No build step: Node 24 executes TypeScript directly (types are erased at load time).
CMD ["node", "src/server.ts"]
```

- [ ] **Step 2: Add the api service to docker-compose.yml**

Append under `services:`:

```yaml
  api:
    build: .
    ports:
      - "3000:3000"
    environment:
      PORT: 3000
      NODE_ENV: production
      LOG_LEVEL: info
      DATABASE_URL: postgres://luarc:luarc@postgres:5432/luarc
      REDIS_URL: redis://redis:6379/0
      # Read from ./.env when present so tokens minted by `npm run load:prepare` verify here.
      JWT_SECRET: ${JWT_SECRET:-dev-only-secret-change-me-before-any-real-deployment}
      TRUST_PROXY: "false"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    command: sh -c "node src/db/migrate.ts && node src/db/seed.ts && node src/server.ts"
```

- [ ] **Step 3: Verify the full stack end to end**

```bash
docker-compose up -d --build
sleep 8
curl -s localhost:3000/health; echo
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H 'content-type: application/json' -d '{"email":"demo@luarc.test","password":"demo-password-123"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).access_token))')
curl -s localhost:3000/coupons/stats -H "authorization: Bearer $TOKEN"; echo
docker-compose logs api | tail -5
```

Expected: health `ok`; stats show 5 coupons; logs show migrations, seed, `listening`. Then `docker-compose down` when done (Postgres data is ephemeral by design; tests and dev use their own compose services started in Task 1, which this command also stops, so bring `postgres redis` back up afterwards with `docker-compose up -d postgres redis`).

- [ ] **Step 4: Create .github/workflows/ci.yml**

```yaml
name: ci
on:
  push:
    branches: [main, feat/**]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: luarc
          POSTGRES_PASSWORD: luarc
          POSTGRES_DB: luarc_test
        ports: ["5434:5432"]
        options: >-
          --health-cmd "pg_isready -U luarc"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
      redis:
        image: redis:7-alpine
        ports: ["6380:6379"]
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test

  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t luarc-asset-api .
```

The service ports match `.env.test`, so the test script runs unchanged in CI.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml .github/workflows/ci.yml
git commit -m "chore: container image, one-command compose stack, CI"
```

---

### Task 14: k6 load test with fixture generator

**Files:**
- Create: `load/prepare.ts`, `load/claim-race.js`

- [ ] **Step 1: Create load/prepare.ts**

```ts
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { hashPassword } from '../src/auth/passwords.ts';
import { createTokens } from '../src/auth/tokens.ts';
import { loadConfig } from '../src/config.ts';
import { createDb } from '../src/db/index.ts';

// Mints N users and access tokens straight into the database, bypassing /auth/register so the
// auth rate limiter does not interfere with the load test. Writes load/fixtures.json.
const USERS = Number(process.env.LOAD_USERS ?? 300);
const UNITS = Number(process.env.LOAD_UNITS ?? 50);

const config = loadConfig();
const db = createDb(config.DATABASE_URL, 5);
const tokens = createTokens(config);

try {
  const run = randomUUID().slice(0, 8);
  const hash = await hashPassword('load-test-password');
  const users = await db
    .insertInto('users')
    .values(Array.from({ length: USERS }, (_, i) => ({ email: `load-${run}-${i}@load.local`, password_hash: hash })))
    .returning(['id', 'email'])
    .execute();
  const coupon = await db
    .insertInto('coupons')
    .values({ code: `RACE-${run.toUpperCase()}`, title: `Load test ${run}`, total_quantity: UNITS, created_by: users[0]!.id })
    .returning(['id', 'code'])
    .executeTakeFirstOrThrow();
  const accessTokens = await Promise.all(users.map((u) => tokens.signAccess(u)));
  const out = path.join(import.meta.dirname, 'fixtures.json');
  writeFileSync(out, JSON.stringify({ coupon_id: coupon.id, coupon_code: coupon.code, units: UNITS, tokens: accessTokens }, null, 2));
  console.log(`wrote ${out}: coupon ${coupon.code} with ${UNITS} units, ${USERS} users`);
} finally {
  await db.destroy();
}
```

- [ ] **Step 2: Create load/claim-race.js**

```js
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const fixtures = JSON.parse(open('./fixtures.json'));
const BASE = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  scenarios: {
    race: { executor: 'per-vu-iterations', vus: fixtures.tokens.length, iterations: 1, maxDuration: '2m' },
  },
  thresholds: {
    server_errors: ['count==0'],
    http_req_duration: ['p(95)<1000'],
  },
};

const claimed = new Counter('claims_201');
const soldOut = new Counter('claims_410');
const duplicate = new Counter('claims_409');
const serverErrors = new Counter('server_errors');

export default function () {
  const token = fixtures.tokens[__VU - 1];
  const res = http.post(`${BASE}/coupons/${fixtures.coupon_id}/claims`, null, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 201) claimed.add(1);
  else if (res.status === 410) soldOut.add(1);
  else if (res.status === 409) duplicate.add(1);
  else serverErrors.add(1);
  check(res, { 'no 5xx': (r) => r.status < 500 });
}

export function teardown() {
  const res = http.get(`${BASE}/coupons/${fixtures.coupon_id}`, {
    headers: { Authorization: `Bearer ${fixtures.tokens[0]}` },
  });
  const body = JSON.parse(res.body);
  console.log(`claimed_count=${body.claimed_count} total_quantity=${body.total_quantity} remaining=${body.remaining}`);
  if (body.claimed_count !== fixtures.units) {
    throw new Error(`INVARIANT VIOLATED: claimed_count ${body.claimed_count} != units ${fixtures.units}`);
  }
}
```

- [ ] **Step 3: Run it against the compose stack and record the output**

```bash
docker-compose up -d --build
sleep 8
npm run load:prepare
npm run load 2>&1 | tee /tmp/k6-output.txt
```

Expected: `claims_201......: 50`, `claims_410......: 250`, `server_errors...: 0`, and the teardown line `claimed_count=50 total_quantity=50 remaining=0`. The `npm run load` script uses the `grafana/k6` Docker image with `--network host`, so no local k6 install is needed. Keep `/tmp/k6-output.txt` for the README.

- [ ] **Step 4: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean (`load/prepare.ts` is in the tsconfig include list).

```bash
git add load/prepare.ts load/claim-race.js
git commit -m "test(load): k6 claim race with pre-minted fixtures"
```

---

### Task 15: README

**Files:**
- Modify: `README.md` (replace entirely)

- [ ] **Step 1: Write README.md**

Write the following, then fill the three `PASTE:` blocks from `/tmp/test-output.txt` (concurrency section only), `/tmp/k6-output.txt` (the summary table and teardown line), and `/tmp/explain-history.txt` + `/tmp/explain-pool.txt`.

````markdown
# Luarc Asset Management API

A coupon/voucher pool where authenticated users claim limited units, built so that the system stays
**exactly** consistent when hundreds of users race for the same coupon or edit the same record.

- **Consistency-first.** Every invariant is enforced by Postgres (UNIQUE, CHECK, row locks), not by
  application code that hopes nobody races it. The claim path is two SQL statements and zero explicit locks.
- **Proven, not asserted.** The test suite fires 500 concurrent claims at 50 units and checks that exactly 50
  land and the counter equals the row count. A k6 script does the same over real HTTP.
- **Secure auth.** scrypt passwords, short-lived HS256 JWTs, rotating refresh tokens with reuse detection.
- **Boring where it should be.** Express 5, Kysely, zod, pino, one Docker Compose file, GitHub Actions.

## Quick start

```bash
docker compose up -d --build        # Postgres 16 + Redis 7 + API; runs migrations and seed
open http://localhost:3000/docs     # Swagger UI
```

Walk the whole flow with curl:

```bash
# 1. Log in as the seeded demo user
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"demo@luarc.test","password":"demo-password-123"}' | jq -r .access_token)

# 2. See the global pool (RACE-50 has 50 units)
curl -s localhost:3000/coupons?available=true -H "authorization: Bearer $TOKEN" | jq '.data[] | {code, remaining, claimed_by_me}'

# 3. Claim one
ID=$(curl -s localhost:3000/coupons?q=RACE-50 -H "authorization: Bearer $TOKEN" | jq -r '.data[0].id')
curl -s -X POST localhost:3000/coupons/$ID/claims -H "authorization: Bearer $TOKEN" | jq

# 4. Claim again → 409 already-claimed (safe to retry, nothing changes)
curl -s -X POST localhost:3000/coupons/$ID/claims -H "authorization: Bearer $TOKEN" | jq

# 5. Your history and the pool stats
curl -s localhost:3000/me/claims -H "authorization: Bearer $TOKEN" | jq
curl -si localhost:3000/coupons/stats -H "authorization: Bearer $TOKEN" | grep -iE 'x-cache|claimed_units|total_claims'
```

Local development without the API container:

```bash
docker compose up -d postgres redis
cp .env.example .env
npm ci && npm run migrate && npm run seed
npm run dev                          # http://localhost:3000
npm test                             # real Postgres + Redis, no mocks
```

## API overview

| Method | Path | Auth | What it does |
|---|---|---|---|
| POST | /auth/register | – | Create account, receive token pair |
| POST | /auth/login | – | Credentials → token pair (identical 401 for unknown email / wrong password) |
| POST | /auth/refresh | – | Rotate refresh token; replay of a rotated token revokes the whole family |
| POST | /auth/logout | – | Revoke a refresh token |
| GET | /me | Bearer | Current user |
| GET | /me/claims | Bearer | **Your history**: claims ⋈ coupons, filters `from`/`to`/`coupon_status`, keyset pagination |
| POST | /coupons | Bearer | Create a coupon (you become its owner) |
| GET | /coupons | Bearer | **Global pool**: every coupon with `remaining` and `claimed_by_me`, filters `status`/`available`/`q` |
| GET | /coupons/stats | Bearer | Aggregate totals, cached 5s in Redis, invalidated on every write |
| GET | /coupons/{id} | Bearer | One coupon |
| PATCH | /coupons/{id} | Bearer, owner | Edit with optimistic locking (`version` in body) |
| POST | /coupons/{id}/claims | Bearer | **Claim one unit** — the concurrency-critical path |
| GET | /health | – | Postgres and Redis checks |

Full contract: [`openapi.yaml`](openapi.yaml), served at `/docs`. A test asserts every registered route is documented.

Errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details. Problem types:
`validation-error`, `invalid-json`, `payload-too-large`, `unauthorized`, `forbidden`, `not-found`, `email-taken`,
`invalid-credentials`, `invalid-refresh-token`, `code-taken`, `already-claimed`, `coupon-sold-out`, `coupon-expired`,
`coupon-disabled`, `version-conflict`, `quantity-below-claimed`, `unknown-user`, `rate-limited`, `internal`.
Every error carries the `request_id` that also appears in the structured logs.

## Data model

```mermaid
erDiagram
  users ||--o{ refresh_tokens : has
  users ||--o{ coupons : owns
  users ||--o{ claims : makes
  coupons ||--o{ claims : receives
  users { uuid id PK; text email UK; text password_hash; timestamptz created_at }
  refresh_tokens { uuid id PK; uuid user_id FK; text token_hash UK; timestamptz expires_at; timestamptz revoked_at }
  coupons { uuid id PK; text code UK; text status; int total_quantity; int claimed_count; timestamptz expires_at; int version; uuid created_by FK }
  claims { bigint id PK; uuid coupon_id FK; uuid user_id FK; timestamptz claimed_at }
```

Invariants, all enforced by the database:

1. `0 <= claimed_count <= total_quantity` — `CHECK coupons_claimed_within_total`. The oversell backstop.
2. One claim per (coupon, user) — `UNIQUE claims_coupon_id_user_id_key`.
3. `claimed_count = COUNT(claims)` for every coupon — maintained by the claim transaction below and made
   observable by `/coupons/stats`, which returns both numbers.

`remaining` is derived (`total_quantity - claimed_count`), never stored, so it cannot drift. "Sold out" is
`remaining = 0`, not a status flag.

## Consistency design

### Claiming: insert, then conditional update

```sql
BEGIN;  -- READ COMMITTED

-- 1. Uniqueness gate. A duplicate dies here on the unique index without touching the hot row.
INSERT INTO claims (coupon_id, user_id) VALUES ($coupon, $user);

-- 2. Compare-and-swap. Postgres takes the row lock inside the UPDATE and re-evaluates the WHERE
--    against the newest committed row once any concurrent writer finishes.
UPDATE coupons
   SET claimed_count = claimed_count + 1, updated_at = now()
 WHERE id = $coupon
   AND status = 'active'
   AND (expires_at IS NULL OR expires_at > now())
   AND claimed_count < total_quantity
RETURNING claimed_count, total_quantity;
-- 0 rows → read the row to say why (sold out / expired / disabled) → ROLLBACK undoes the INSERT.

COMMIT;
```

Source: [`src/coupons/service.ts`](src/coupons/service.ts) (`claimCoupon`).

| Alternative | Why not |
|---|---|
| `SELECT … FOR UPDATE`, check in app, `UPDATE` | Correct, but two round trips and the check lives in JavaScript. The conditional `UPDATE` takes the same lock with the check in SQL. |
| `SERIALIZABLE` + retry loop | Correct, but pays serialization-failure retries under exactly the contention we are designing for. Pointless when one row is the whole conflict set. |
| Redis / in-process mutex | Not durable, not transactional, wrong layer. The database already owns the row lock. |
| Read count, then blind `UPDATE SET claimed_count = $n` | Lost update. This is the bug the exercise is about. |

**Why READ COMMITTED is enough.** The predicate is re-checked after the lock is acquired (Postgres's
EvalPlanQual), so two transactions cannot both see `claimed_count < total_quantity` and both increment past it.
The unique index serialises duplicate inserts: the second inserter blocks until the first commits, then fails.

**Deadlock freedom.** Every claim touches its own new `claims` row, then one `coupons` row, always in that order.
The FK check takes `FOR KEY SHARE` on the coupon; the `UPDATE` of non-key columns takes `FOR NO KEY UPDATE`,
which is compatible with it. Concurrent claims on one coupon simply queue on the row lock.

**Idempotent retries.** A client that times out and retries gets 409 `already-claimed`, and nothing changes.

### Editing: optimistic locking with an explicit version

`PATCH /coupons/{id}` requires the `version` the client last read. The update is a single statement:

```sql
UPDATE coupons SET …, version = version + 1
 WHERE id = $id AND created_by = $me AND version = $expected
```

Zero rows means not found, not owner, or stale — the service re-reads to tell you which (404 / 403 / 409 with
`current_version`). Shrinking `total_quantity` below `claimed_count` is refused by the CHECK constraint → 422.

**Why not ETag / If-Match?** It is the HTTP-native choice and was the first draft. It was dropped because an
RFC-correct ETag must change whenever the representation changes, and `claimed_count` changes on every claim.
An editor of a busy coupon would get 412 in a loop and never land an edit. `version` increments only on edits, so
edits and claims are independent: they touch disjoint columns under the same row lock, and the CHECK constraint
arbitrates the one interaction.

## Concurrency proof

`npm test` runs [`test/concurrency.test.ts`](test/concurrency.test.ts) against a real Postgres:

| Scenario | Expectation |
|---|---|
| 500 users race for 50 units | exactly 50 × 201, 450 × 410, `claimed_count = COUNT(claims) = 50`, 50 distinct winners |
| One user fires 100 parallel claims | exactly 1 × 201, 99 × 409, one row |
| 20 concurrent PATCHes with the same version | exactly 1 × 200, 19 × 409, `version = 2` |
| 50 claims and 10 edits interleaved on one coupon | no 500s, 30 claims land on 30 units, one edit wins |

```
PASTE: the concurrency.test.ts section of `npm test` output
```

Over real HTTP with k6 (`npm run load:prepare && npm run load`, 300 virtual users, 50 units):

```
PASTE: k6 summary lines for claims_201, claims_410, server_errors, http_req_duration, and the teardown line
```

## Authentication

```mermaid
sequenceDiagram
  participant C as Client
  participant A as API
  participant P as Postgres
  C->>A: POST /auth/login {email, password}
  A->>P: SELECT user by email
  A->>A: scrypt verify (dummy hash if unknown → constant time)
  A->>P: INSERT refresh_tokens (sha256 of token)
  A-->>C: {access_token (JWT 15m), refresh_token (opaque 30d)}
  C->>A: POST /auth/refresh {refresh_token}
  A->>P: SELECT … FOR UPDATE by hash
  alt revoked_at set (replay)
    A->>P: revoke every live token for user
    A-->>C: 401
  else valid
    A->>P: revoke old, INSERT new
    A-->>C: new pair
  end
```

- **Passwords**: `node:crypto` scrypt, N=2^15, r=8, p=3 (OWASP-listed), per-hash salt, parameters stored in the
  hash string so they can be raised later. Zero dependencies and no native build in Docker; bcrypt or argon2 would
  be equally acceptable.
- **Access tokens**: HS256 JWT, 15 minutes, verified with an explicit algorithm allow-list, issuer and audience.
  Claims are `sub`, `email`, `role`, `aud`, `iss`, `iat`, `exp` — the same shape Supabase Auth issues, so a client
  written against Supabase reads ours unchanged.
- **Refresh tokens**: 256-bit opaque, stored as SHA-256, rotated on every use. Presenting an already-rotated token
  is treated as theft and revokes the user's whole token family (OAuth 2.0 Security BCP). Clients must not refresh
  concurrently.
- **Not built, on purpose**: verifying Supabase-issued tokens (JWKS, ES256). It would also need user provisioning on
  first sight; half of that feature is worse than none.

## Redis: what is cached and what never is

- **Rate limit** on `/auth/*`: fixed window per IP, `INCR` + `EXPIRE`, 10 per minute by default, 429 with `Retry-After`.
- **Stats cache**: `GET /coupons/stats` is served from Redis for up to 5 seconds and the key is deleted after every
  coupon create, edit, or claim. `X-Cache: HIT|MISS` tells you which. Staleness bound: `STATS_CACHE_TTL_SECONDS`.
- **Never cached**: anything on the claim or edit path. Those are the things being kept consistent.
- **Fail-open**: if Redis is down the limiter lets requests through, the cache misses, `/health` says `degraded`,
  and the core API keeps working (tested). Flip the limiter to fail-closed if brute-force protection ever matters more
  than availability.

## Query performance

Indexes and the queries they serve:

| Index | Query |
|---|---|
| `claims_user_id_id_idx (user_id, id)` | `/me/claims`: `WHERE user_id = $1 AND id < $cursor ORDER BY id DESC LIMIT n` — one backward index scan |
| `coupons_status_code_idx (status, code)` | `/coupons?status=…`: filter + `ORDER BY code` + keyset `code > $cursor` |
| `coupons_code_key` | code lookup, keyset cursor when unfiltered |
| `claims_coupon_id_user_id_key` | duplicate-claim gate and `claimed_by_me` join |

Pagination is keyset (cursor = last sort key, base64url), not `OFFSET`: stable under concurrent inserts and
index-friendly at any depth. `claims.id` is a bigint identity so the cursor is exact; timestamps are not used as
cursors because they lose microseconds in JavaScript.

```
PASTE: EXPLAIN (ANALYZE, BUFFERS) for the history query and the pool listing
```

## Operations

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | |
| `DATABASE_URL` | – | Postgres connection string |
| `PG_POOL_MAX` | 10 | Connections per API instance |
| `REDIS_URL` | – | Redis connection string |
| `JWT_SECRET` | – | HS256 key, ≥ 32 chars |
| `JWT_ISSUER` / `JWT_AUDIENCE` | luarc-asset-api / authenticated | Verified on every token |
| `ACCESS_TOKEN_TTL_SECONDS` | 900 | |
| `REFRESH_TOKEN_TTL_SECONDS` | 2592000 | 30 days |
| `RATE_LIMIT_AUTH_MAX` / `RATE_LIMIT_AUTH_WINDOW_SECONDS` | 10 / 60 | Per IP on `/auth/*` |
| `STATS_CACHE_TTL_SECONDS` | 5 | |
| `TRUST_PROXY` | false | Set true behind a load balancer so rate limiting sees the client IP |
| `LOG_LEVEL` | info | pino level |

- Config is validated at startup; a bad value exits with a readable message.
- Structured JSON logs with a request id per line; `X-Request-Id` is honoured or generated and echoed.
- `SIGTERM` drains in-flight requests, closes the pool and Redis, exits 0 (10s hard limit) — clean ECS rollouts.
- `GET /health`: `SELECT 1` and `PING` with timeouts; 503 only if Postgres is down.
- Tests run in CI against Postgres and Redis service containers; the Docker image is built on every push.

## Deploying on AWS

```mermaid
flowchart LR
  U[Clients] --> ALB[Application Load Balancer]
  ALB --> T1[ECS Fargate task]
  ALB --> T2[ECS Fargate task]
  T1 --> RDS[(RDS PostgreSQL 16<br/>Multi-AZ)]
  T2 --> RDS
  T1 --> EC[(ElastiCache Redis)]
  T2 --> EC
  SM[Secrets Manager<br/>JWT_SECRET, DATABASE_URL] -.-> T1
  SM -.-> T2
  T1 --> CW[CloudWatch Logs]
  T2 --> CW
  M[One-off ECS task:<br/>node src/db/migrate.ts] --> RDS
```

- The API is stateless; scale ECS tasks horizontally behind the ALB. Set `TRUST_PROXY=true`.
- Run migrations as a one-off task before rolling out the new image, never at container start in production
  (Compose does it at start only for convenience).
- Secrets come from Secrets Manager into the task definition; nothing is baked into the image.
- RDS Multi-AZ for the single source of truth; ElastiCache is disposable — the app degrades without it.
- Supabase is Postgres, so this schema and every constraint port unchanged if the data layer moves there.

### Scaling notes and the honest ceiling

One hot coupon row serialises its claims at roughly the database's commit latency — thousands per second on
RDS-class hardware, far above the brief's "hundreds". Past that, the upgrade path is sharded counters or a Redis
`DECR` reservation with asynchronous reconciliation. Both trade the single-row guarantee for coordination
complexity, which is the wrong trade at this scale. Everything else — listing, history, stats — scales with
read replicas and the cache.

## Trade-offs and omissions

| Left out | Why | Upgrade path |
|---|---|---|
| Admin role | Ownership (`created_by`) already gives a clean 401 vs 403 story | A `role` column and a `requireRole` middleware |
| Redeem step after claiming | Not in the brief | Second conditional update: `UPDATE claims SET status='redeemed' WHERE id=$1 AND status='claimed'` |
| Per-coupon claim limit > 1 | UNIQUE constraint is provable and makes retries idempotent | Replace UNIQUE with a count inside the transaction under the row lock |
| Idempotency-Key header | The unique constraint already makes retries safe | Store key → response for non-idempotent endpoints |
| Supabase JWKS verification | Dead-ends without user provisioning | `jose.createRemoteJWKSet` + upsert user on first sight |
| Full-text search | `ILIKE` is fine at this pool size | `pg_trgm` GIN index on `code`, `title` |
| Refresh-token table cleanup | Rows are small and revocation needs history | Nightly `DELETE WHERE expires_at < now() - interval '30 days'` |

## Project layout

```
src/
  server.ts            bootstrap + graceful shutdown
  app.ts               createApp(): middleware, health, routes, error handler
  config.ts            zod-validated environment
  db/                  Kysely types, migration, migrate/seed CLIs
  auth/                scrypt, JWT + refresh tokens, requireAuth, /auth/* routes
  coupons/service.ts   every SQL statement touching coupons and claims (the file to read first)
  coupons/routes.ts    /coupons/*
  claims/routes.ts     /me/claims
  lib/                 problem details, validation, pagination, redis (rate limit + cache)
test/                  node:test against real Postgres + Redis; concurrency.test.ts is the proof
load/                  k6 race script and fixture generator
openapi.yaml           contract, served at /docs
```
````

- [ ] **Step 2: Fill the PASTE blocks**

Replace each `PASTE:` fenced block with the real captured output (trim to the relevant lines). Regenerate any that
are missing: `npm test 2>&1 | grep -A 12 concurrency`, `npm run load`, and the two EXPLAIN commands from Task 11
Step 7. If the pool listing plan shows a Seq Scan because the table is tiny, include the `SET enable_seqscan = off`
variant and say so in one sentence.

- [ ] **Step 3: Verify every command in the README once**

Run the Quick start block verbatim on a clean stack (`docker-compose down && docker-compose up -d --build`).
Each curl must return what the comment says. Fix the README, not the expectations.

- [ ] **Step 4: Final full verification and commit**

```bash
npm run typecheck && npm test
git add README.md
git commit -m "docs: README with design rationale, proofs, and deployment notes"
```

---

## Self-review against the spec

- **§3 data model** → Task 2 (all columns, constraints, indexes named). ✔
- **§4.1 claim CAS** → Task 8; proofs Task 9. ✔  **§4.2 versioned PATCH** → Task 7. ✔  **§4.3 refresh FOR UPDATE** → Task 5. ✔
- **§5 endpoints**: register/login/refresh/logout/me → Task 5; coupons create/get/list → Task 6; PATCH → 7; claims → 8; stats → 10; /me/claims → 11; health → 3; docs → 12. Problem slugs: the plan adds `invalid-json` and `payload-too-large` (body parser errors) to the spec's list; the spec's list is updated to match. ✔
- **§6 auth**: scrypt params, HS256-only verify with allow-list, Supabase-shaped claims, rotation, reuse detection, dummy-hash timing → Tasks 2, 3, 5. ✔
- **§7 Redis**: fail-open limiter and cache, invalidation on create/PATCH/claim, `X-Cache`, degraded health → Tasks 3, 6, 7, 8, 10 (fail-open test in Task 10). ✔
- **§8 cross-cutting**: config validation (1), request ids and redaction (3), body limit and helmet (3), shutdown (3), pg error mapping in one place (3). ✔
- **§10 tests**: every listed case has a test; the auth rate-limit test uses a second app with max 3 as the spec says. ✔
- **§11 delivery**: Dockerfile, compose with migrate+seed, seed contents, CI, README sections 1–11 → Tasks 13, 14, 15. ✔
- **Type consistency**: `createApp` returns `{ app, ctx }` everywhere; `api()` returns `{ status, headers, body }`; `page()` key callback returns the sort key; `HttpProblem(status, slug, title, detail?, extra?)` argument order is the same in every task; constraint names in Task 2 equal the keys in Task 3's maps. ✔
- **Deviations from the spec's layout**: docs registration lives in `src/docs.ts` rather than inline in `app.ts`; health is inline in `app.ts` as specified. Both noted here so the spec and code do not disagree silently.

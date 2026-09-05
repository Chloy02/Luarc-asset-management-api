import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { loadConfig } from '../src/config.ts';
import { createDb, type Db } from '../src/db/index.ts';
import { migrateToLatest } from '../src/db/migrate.ts';
import { seed } from '../src/db/seed.ts';

let db: Db;

beforeEach(async () => {
  if (!db) {
    const cfg = loadConfig();
    db = createDb(cfg.DATABASE_URL, { poolMax: cfg.PG_POOL_MAX });
    await migrateToLatest(db);
  }
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

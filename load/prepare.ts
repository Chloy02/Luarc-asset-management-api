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

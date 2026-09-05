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

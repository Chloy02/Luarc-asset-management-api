import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPgError } from '../src/lib/problem.ts';
import { api, bootTestApp, createCoupon, createUser, type ApiResponse, type TestContext } from './helpers.ts';

// A short lock_timeout so a contended row surfaces as a bounded 503 instead of parking a connection.
let t: TestContext;
before(async () => {
  t = await bootTestApp({ PG_LOCK_TIMEOUT_MS: 200 });
});
after(async () => {
  await t.close();
});

test('a claim blocked on a locked coupon row times out as 503 lock-timeout and leaves no claim behind', async () => {
  const owner = await createUser(t);
  const coupon = await createCoupon(t, owner.token, { total_quantity: 5 });
  const claimer = await createUser(t);

  let blocked!: ApiResponse;
  await t.db.transaction().execute(async (trx) => {
    // Hold FOR UPDATE on the coupon; the claim's FK check wants FOR KEY SHARE and must wait.
    await trx.selectFrom('coupons').selectAll().where('id', '=', coupon.id).forUpdate().execute();
    // Issued from inside the callback so the lock is still held while the claim waits on it.
    blocked = await api(t, 'POST', `/coupons/${coupon.id}/claims`, { token: claimer.token });
  });

  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.type, '/problems/lock-timeout');
  assert.equal(blocked.headers.get('retry-after'), '1');
  assert.equal(blocked.body.retry_after, 1);

  // The lock is released; the retry the client is told to make now succeeds, and the abandoned
  // attempt left nothing behind -- the failed transaction rolled its claim row back.
  const retry = await api(t, 'POST', `/coupons/${coupon.id}/claims`, { token: claimer.token });
  assert.equal(retry.status, 201);
  const after = await api(t, 'GET', `/coupons/${coupon.id}`, { token: owner.token });
  assert.equal(after.body.claimed_count, 1);
});

test('a cancelled statement maps to 503 statement-timeout', () => {
  assert.equal(mapPgError({ code: '57014' })?.slug, 'statement-timeout');
  assert.equal(mapPgError({ code: '55P03' })?.slug, 'lock-timeout');
  assert.equal(mapPgError({ code: '23505' }), null, 'a constraint violation without a constraint name is not ours to map');
});

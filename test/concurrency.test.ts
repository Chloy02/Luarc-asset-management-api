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

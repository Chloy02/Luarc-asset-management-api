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

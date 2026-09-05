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

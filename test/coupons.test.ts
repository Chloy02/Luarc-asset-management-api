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

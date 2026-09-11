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

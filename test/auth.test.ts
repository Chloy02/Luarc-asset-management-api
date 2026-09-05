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

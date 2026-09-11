import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { api, bootTestApp, type TestContext } from './helpers.ts';

let t: TestContext;
before(async () => {
  t = await bootTestApp();
});
after(async () => {
  await t.close();
});

test('GET /health reports both dependencies ok', async () => {
  const res = await api(t, 'GET', '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok', checks: { postgres: 'ok', redis: 'ok' } });
});

test('unknown routes return an RFC 9457 problem with a request id', async () => {
  const res = await api(t, 'GET', '/nope', { headers: { 'x-request-id': 'req-123' } });
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /application\/problem\+json/);
  assert.equal(res.headers.get('x-request-id'), 'req-123');
  assert.equal(res.body.type, '/problems/not-found');
  assert.equal(res.body.status, 404);
  assert.equal(res.body.instance, '/nope');
  assert.equal(res.body.request_id, 'req-123');
});

test('a request id is generated when the client sends none', async () => {
  const res = await api(t, 'GET', '/health');
  assert.ok(res.headers.get('x-request-id'));
});

test('malformed JSON bodies are a 400 problem, not a 500', async () => {
  const res = await fetch(`${t.base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  // undici's Response.json() types as Promise<unknown>; narrow with a cast, no behaviour change.
  const body = (await res.json()) as { type: string };
  assert.equal(body.type, '/problems/invalid-json');
});

test('security headers are present and x-powered-by is not', async () => {
  const res = await api(t, 'GET', '/health');
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('survives idle postgres connections being terminated', async () => {
  // Warm the pool concurrently so several clients exist and go idle, then kill every backend of
  // ours except the one running this statement -- the failover/restart case in one query.
  const warm = await Promise.all(Array.from({ length: 5 }, () => api(t, 'GET', '/health')));
  for (const r of warm) assert.equal(r.status, 200);
  const killed = await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE application_name = 'luarc-asset-api' AND pid <> pg_backend_pid()`.execute(t.db);
  assert.ok(killed.rows.length > 0, 'the pool must have held idle clients for this to prove anything');
  // Without pool.on('error') the process would have died here. A fresh client serves the next request.
  const res = await api(t, 'GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.checks.postgres, 'ok');
});

test('oversized bodies are a 413 problem', async () => {
  const res = await api(t, 'POST', '/auth/register', { body: { email: 'a@b.co', password: 'x'.repeat(200_000) } });
  assert.equal(res.status, 413);
  assert.equal(res.body.type, '/problems/payload-too-large');
});

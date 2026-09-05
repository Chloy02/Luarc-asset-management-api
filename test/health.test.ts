import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
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

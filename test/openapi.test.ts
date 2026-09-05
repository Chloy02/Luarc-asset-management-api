import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createDb } from '../src/db/index.ts';
import { createRedis } from '../src/lib/redis.ts';
import { api, bootTestApp } from './helpers.ts';

/** Every route registered on the Express app must be documented. Minimal YAML walk; we control the file's shape. */
function documentedOperations(yaml: string): Set<string> {
  const ops = new Set<string>();
  let currentPath: string | null = null;
  let inPaths = false;
  for (const line of yaml.split('\n')) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (inPaths && /^\S/.test(line)) inPaths = false;
    if (!inPaths) continue;
    const p = line.match(/^  (\/\S*):\s*$/);
    if (p) {
      currentPath = p[1]!;
      continue;
    }
    const m = line.match(/^    (get|post|put|patch|delete):\s*$/);
    if (m && currentPath) ops.add(`${m[1]!.toUpperCase()} ${currentPath}`);
  }
  return ops;
}

/**
 * Only `app.<method>()` routes are enumerated; `app.use()` mounts such as /docs are middleware and
 * are intentionally outside this contract.
 */
async function registeredOperations(): Promise<Set<string>> {
  const config = loadConfig();
  const logger = pino({ level: 'silent' });
  const db = createDb(config.DATABASE_URL, { poolMax: 1 });
  const redis = createRedis(config.REDIS_URL, logger);
  const { app } = createApp({ config, db, redis, logger });
  const ops = new Set<string>();
  type Layer = { route?: { path: string; methods: Record<string, boolean> } };
  const stack = (app as unknown as { router: { stack: Layer[] } }).router.stack;
  for (const layer of stack) {
    if (!layer.route) continue;
    const oaPath = layer.route.path.replace(/:([A-Za-z_]+)/g, '{$1}');
    for (const method of Object.keys(layer.route.methods)) ops.add(`${method.toUpperCase()} ${oaPath}`);
  }
  await db.destroy();
  return ops;
}

test('every Express route is documented in openapi.yaml', async () => {
  const yaml = readFileSync(path.join(import.meta.dirname, '..', 'openapi.yaml'), 'utf8');
  const documented = documentedOperations(yaml);
  const registered = await registeredOperations();
  registered.delete('GET /openapi.yaml');
  const missing = [...registered].filter((op) => !documented.has(op)).sort();
  assert.deepEqual(missing, [], `undocumented routes: ${missing.join(', ')}`);
  const stale = [...documented].filter((op) => !registered.has(op)).sort();
  assert.deepEqual(stale, [], `documented but not registered: ${stale.join(', ')}`);
});

test('serves the spec and Swagger UI over HTTP', async () => {
  const t = await bootTestApp();
  try {
    const spec = await api(t, 'GET', '/openapi.yaml');
    assert.equal(spec.status, 200);
    assert.match(spec.headers.get('content-type') ?? '', /application\/yaml/);
    assert.ok(String(spec.body).startsWith('openapi: 3.1.0'));

    const ui = await api(t, 'GET', '/docs/');
    assert.equal(ui.status, 200);
    assert.match(ui.headers.get('content-type') ?? '', /text\/html/);
    // Swagger UI's inline script/style is allowed on /docs and nowhere else.
    assert.match(ui.headers.get('content-security-policy') ?? '', /script-src 'self' 'unsafe-inline'/);
    const health = await api(t, 'GET', '/health');
    const csp = health.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self';/);
    assert.doesNotMatch(csp, /script-src 'self' 'unsafe-inline'/, 'the relaxed CSP must not leak past /docs');
  } finally {
    await t.close();
  }
});

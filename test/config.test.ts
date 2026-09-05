import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

const minimal = {
  DATABASE_URL: 'postgres://u:p@localhost:5434/db',
  REDIS_URL: 'redis://localhost:6380/0',
  JWT_SECRET: 'x'.repeat(32),
};

test('loadConfig applies documented defaults', () => {
  const cfg = loadConfig(minimal);
  assert.equal(cfg.PORT, 3000);
  assert.equal(cfg.NODE_ENV, 'development');
  assert.equal(cfg.PG_POOL_MAX, 10);
  assert.equal(cfg.JWT_ISSUER, 'luarc-asset-api');
  assert.equal(cfg.JWT_AUDIENCE, 'authenticated');
  assert.equal(cfg.ACCESS_TOKEN_TTL_SECONDS, 900);
  assert.equal(cfg.REFRESH_TOKEN_TTL_SECONDS, 2592000);
  assert.equal(cfg.RATE_LIMIT_AUTH_MAX, 10);
  assert.equal(cfg.RATE_LIMIT_AUTH_WINDOW_SECONDS, 60);
  assert.equal(cfg.STATS_CACHE_TTL_SECONDS, 5);
  assert.equal(cfg.TRUST_PROXY, false);
});

test('loadConfig coerces numbers and booleans from strings', () => {
  const cfg = loadConfig({ ...minimal, PORT: '8080', TRUST_PROXY: 'true', RATE_LIMIT_AUTH_MAX: '3' });
  assert.equal(cfg.PORT, 8080);
  assert.equal(cfg.TRUST_PROXY, true);
  assert.equal(cfg.RATE_LIMIT_AUTH_MAX, 3);
});

test('loadConfig rejects a short JWT_SECRET with a readable message', () => {
  assert.throws(() => loadConfig({ ...minimal, JWT_SECRET: 'short' }), /JWT_SECRET/);
});

test('loadConfig rejects a missing DATABASE_URL', () => {
  const { DATABASE_URL: _omit, ...rest } = minimal;
  assert.throws(() => loadConfig(rest), /DATABASE_URL/);
});

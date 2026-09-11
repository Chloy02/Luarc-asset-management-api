import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { createTokens } from '../src/auth/tokens.ts';
import { loadConfig } from '../src/config.ts';

const config = loadConfig();
const tokens = createTokens(config);
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'a@b.c' };

test('access token round-trips the user', async () => {
  const jwt = await tokens.signAccess(user);
  assert.deepEqual(await tokens.verifyAccess(jwt), user);
});

test('access token carries Supabase-shaped claims', async () => {
  const jwt = await tokens.signAccess(user);
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString());
  assert.equal(payload.sub, user.id);
  assert.equal(payload.email, user.email);
  assert.equal(payload.role, 'authenticated');
  assert.equal(payload.aud, config.JWT_AUDIENCE);
  assert.equal(payload.iss, config.JWT_ISSUER);
  assert.equal(payload.exp - payload.iat, config.ACCESS_TOKEN_TTL_SECONDS);
});

test('tampered, foreign-audience, and expired tokens are rejected', async () => {
  const good = await tokens.signAccess(user);
  const tampered = good.slice(0, -2) + (good.endsWith('a') ? 'bb' : 'aa');
  await assert.rejects(tokens.verifyAccess(tampered));

  const secret = new TextEncoder().encode(config.JWT_SECRET);
  const now = Math.floor(Date.now() / 1000);
  const wrongAud = await new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer(config.JWT_ISSUER)
    .setAudience('someone-else')
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(secret);
  await assert.rejects(tokens.verifyAccess(wrongAud));

  const expired = await new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setIssuedAt(now - 120)
    .setExpirationTime(now - 60)
    .sign(secret);
  await assert.rejects(tokens.verifyAccess(expired));
});

test('refresh tokens are 32 random bytes, hashed with sha256', () => {
  const { token, hash } = tokens.newRefreshToken();
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(tokens.hashRefreshToken(token), hash);
  assert.notEqual(tokens.newRefreshToken().token, token);
});

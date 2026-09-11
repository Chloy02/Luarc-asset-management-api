import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/passwords.ts';

test('hash round-trips and encodes its parameters', async () => {
  const hash = await hashPassword('hunter22hunter22');
  assert.ok(hash.startsWith('scrypt$32768$8$3$'), hash);
  assert.equal(hash.split('$').length, 6);
  assert.equal(await verifyPassword('hunter22hunter22', hash), true);
  assert.equal(await verifyPassword('hunter22hunter23', hash), false);
});

test('two hashes of the same password differ (random salt)', async () => {
  const a = await hashPassword('same-password-1');
  const b = await hashPassword('same-password-1');
  assert.notEqual(a, b);
});

test('garbage stored hashes verify as false instead of throwing', async () => {
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
  assert.equal(await verifyPassword('anything', 'bcrypt$1$2$3$4$5'), false);
});

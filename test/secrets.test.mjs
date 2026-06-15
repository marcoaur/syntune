// Segurança: envelope AES-256-GCM (src/config/secrets.js). Não cobre safeStorage
// (loadOrCreateMasterKey) — depende do cofre do SO; só a cripto pura.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encryptSecrets, decryptSecrets, SECRETS_MAGIC } from '../src/config/secrets.js';

const key = () => crypto.randomBytes(32);

test('roundtrip: decrypt(encrypt(x)) === x', () => {
  const k = key();
  const obj = { apiKey: 'abc', geniusToken: 'z', n: 'José' };
  const dec = decryptSecrets(k, encryptSecrets(k, obj));
  assert.deepEqual(dec, obj);
});

test('formato: começa com magic SYN1', () => {
  const enc = encryptSecrets(key(), { a: 1 });
  assert.equal(enc.subarray(0, 4).toString(), 'SYN1');
  assert.ok(SECRETS_MAGIC.equals(Buffer.from('SYN1')));
});

test('magic ausente/curto → {} (não lança)', () => {
  assert.deepEqual(decryptSecrets(key(), Buffer.from('XXXX')), {});
  assert.deepEqual(decryptSecrets(key(), Buffer.alloc(10)), {});
  assert.deepEqual(decryptSecrets(key(), null), {});
});

test('ciphertext adulterado → lança (GCM authTag)', () => {
  const k = key();
  const enc = encryptSecrets(k, { a: 1 });
  const tampered = Buffer.from(enc);
  tampered[tampered.length - 1] ^= 0x01; // vira 1 bit do ct
  assert.throws(() => decryptSecrets(k, tampered));
});

test('chave errada → lança', () => {
  const enc = encryptSecrets(key(), { a: 1 });
  assert.throws(() => decryptSecrets(key(), enc));
});

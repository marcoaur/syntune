// Helpers puros de formatação (renderer/modules/format.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { normPart, keyOf, normalizeText, fmtBytes, fmtDb, artistInitials } from '../renderer/modules/format.js';

test('normPart: minúsculo + colapsa espaços', () => {
  assert.equal(normPart('  Aa   Bb '), 'aa bb');
  assert.equal(normPart(null), '');
});

test('keyOf: title|artist|year normalizados', () => {
  assert.equal(keyOf({ title: 'T x', artist: 'A', year: 1999 }), 't x|a|1999');
  assert.equal(keyOf({ title: 'T', artist: 'A', year: null }), 't|a|');
});

test('normalizeText: minúsculo sem acentos', () => {
  assert.equal(normalizeText('Café Ô'), 'cafe o');
});

test('fmtBytes: escalas e arredondamento', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(1024), '1.0 KB');
  assert.equal(fmtBytes(1536), '1.5 KB');
  assert.equal(fmtBytes(1048576), '1.0 MB');
});

test('fmtDb: sinal explícito', () => {
  assert.equal(fmtDb(3), '+3 dB');
  assert.equal(fmtDb(-2), '-2 dB');
  assert.equal(fmtDb(0), '0 dB');
});

test('artistInitials: 1 vs N palavras vs vazio', () => {
  assert.equal(artistInitials('The Beatles'), 'TB');
  assert.equal(artistInitials('Madonna'), 'MA');
  assert.equal(artistInitials(''), '♪');
});

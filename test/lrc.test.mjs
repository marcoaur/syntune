// Parsing/serialização de letra sincronizada (renderer/modules/lrc.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSyncedLyrics, parseLrc, lrcToPlain, parseLrcTime, fmtTimestamp,
  parseLrcSeconds, parseLyricsToLines, serializeLines
} from '../renderer/modules/lrc.js';

test('isSyncedLyrics detecta tags de tempo', () => {
  assert.equal(isSyncedLyrics('[00:01.00]oi'), true);
  assert.equal(isSyncedLyrics('só texto'), false);
  assert.equal(isSyncedLyrics(''), false);
});

test('parseLrc: ordena por tempo e ignora metadados', () => {
  const r = parseLrc('[ti:X]\n[00:10.50]a\n[00:05.00]b');
  assert.deepEqual(r, [{ t: 5, text: 'b' }, { t: 10.5, text: 'a' }]);
});

test('parseLrc: aplica [offset] em segundos (ms/1000)', () => {
  assert.equal(parseLrc('[offset:500]\n[00:10.00]a')[0].t, 10.5);
  assert.equal(parseLrc('[offset:-500]\n[00:10.00]a')[0].t, 9.5);
});

test('parseLrc: texto sem tag → null', () => {
  assert.equal(parseLrc('linha sem tempo'), null);
});

test('lrcToPlain remove tags e linhas de metadado', () => {
  assert.equal(lrcToPlain('[ar:Z]\n[00:01.00]a\n[00:02.00]b'), 'a\nb');
});

test('parseLrcTime normaliza para mm:ss.xx (segundos com 2 dígitos)', () => {
  assert.equal(parseLrcTime('1:23.5'), '01:23.50');
  assert.equal(parseLrcTime('00:05'), '00:05.00');
  assert.equal(parseLrcTime('xx'), '');
});

test('fmtTimestamp e parseLrcSeconds são inversos aproximados', () => {
  assert.equal(fmtTimestamp(83.456), '01:23.46');
  assert.equal(parseLrcSeconds('01:23.45'), 83.45);
  assert.equal(parseLrcSeconds(''), -1);
});

test('parseLyricsToLines separa tempo+texto do editor', () => {
  assert.deepEqual(parseLyricsToLines('[00:01.00]oi\nplano'),
    [{ time: '00:01.00', text: 'oi' }, { time: '', text: 'plano' }]);
});

test('serializeLines descarta vazias e emite 1 linha por verso', () => {
  const out = serializeLines([
    { time: '00:01.00', text: 'oi' },
    { time: '', text: '   ' },
    { time: '', text: 'a\nb' }
  ]);
  assert.equal(out, '[00:01.00]oi\na b');
});

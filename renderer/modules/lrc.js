/**
 * @module  renderer/lrc
 * @badge   ⬜ UTIL · RENDERER · PURE · ESM
 * @role    Parsing/serialização de letra sincronizada (LRC) no lado UI: detecção, parse p/ {t,text}, parse p/ editor {time,text}, timestamps e texto puro.
 * @inputs  texto LRC bruto, listas de linhas do editor, strings de tempo
 * @outputs arrays {t,text}/{time,text}, segundos, strings LRC/plain
 * @deps    (nenhum)
 */
export function isSyncedLyrics(text) { return !!(text && /\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(text)); }

export function parseLrc(text) {
  if (!text) return null;
  const out = [];
  let offset = 0;
  const tagRe = /\[(\d{1,2}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
  for (const raw of String(text).split(/\r?\n/)) {
    const off = raw.match(/^\s*\[offset:\s*(-?\d+)\]/i);
    if (off) { offset = parseInt(off[1], 10) / 1000; continue; }
    if (/^\s*\[(ti|ar|al|au|by|length|re|ve|tool|#):/i.test(raw)) continue;
    const times = []; let m; tagRe.lastIndex = 0;
    while ((m = tagRe.exec(raw)) !== null) {
      times.push(parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(':', '.')));
    }
    if (!times.length) continue;
    const txt = raw.replace(tagRe, '').trim();
    for (const t of times) out.push({ t: t + offset, text: txt });
  }
  out.sort((a, b) => a.t - b.t);
  return out.length ? out : null;
}

export function lrcToPlain(text) {
  return String(text || '').split(/\r?\n/)
    .filter((l) => !/^\s*\[(ti|ar|al|au|by|length|re|ve|offset|tool|#):/i.test(l))
    .map((l) => l.replace(/\[[^\]]*\]/g, '').trim())
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function parseLrcTime(raw) {
  const m = raw.match(/(\d{1,2}):(\d{2}(?:\.\d+)?)/);
  if (!m) return '';
  return m[1].padStart(2, '0') + ':' + parseFloat(m[2]).toFixed(2).padStart(5, '0');
}

export function fmtTimestamp(seconds) {
  if (!seconds && seconds !== 0) return '';
  const s = Math.max(0, seconds);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = (s % 60).toFixed(2).padStart(5, '0');
  return mm + ':' + ss;
}

export function parseLrcSeconds(timeStr) {
  // '01:23.45' -> 83.45
  if (!timeStr) return -1;
  const m = timeStr.match(/(\d{1,2}):(\d{2}(?:\.\d+)?)/);
  if (!m) return -1;
  return parseInt(m[1], 10) * 60 + parseFloat(m[2]);
}

export function parseLyricsToLines(raw) {
  if (!raw) return [{ time: '', text: '' }];
  const out = [];
  raw.split('\n').forEach(l => {
    const m = l.match(/^\[(\d{1,2}:\d{2}(?:\.\d+)?)\]\s?(.*)$/);
    if (m) out.push({ time: parseLrcTime(m[1]), text: m[2] });
    else if (l.trim()) out.push({ time: '', text: l.trim() });
  });
  return out.length ? out : [{ time: '', text: '' }];
}

export function serializeLines(lines) {
  // Só serializa linhas com texto real — descarta linhas vazias e timestamps órfãos
  return lines.filter(l => l.text && l.text.trim()).map(l => {
    const t = l.time ? `[${l.time}]` : '';
    return t + l.text.replace(/[\r\n]+/g, ' '); // garante 1 linha LRC por verso
  }).join('\n');
}

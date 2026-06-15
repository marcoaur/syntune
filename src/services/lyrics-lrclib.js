/**
 * @module  services/lyrics-lrclib
 * @badge   🟦 SERVICE · NETWORK · CRYPTO(sha256-PoW) · STATELESS
 * @role    Letra sincronizada (LRC) via LRCLIB — grátis, sem chave: busca (get exato + search), detecção de LRC, e proof-of-work p/ publicar.
 * @inputs  { artist, title, album, duration }, texto de letra
 * @outputs { synced, plain }, boolean, token PoW "prefix:nonce"|null
 * @deps    crypto, global fetch
 * @notes   solveLrclibChallenge faz hashing intensivo (até 20M nonces). UA dedicado.
 */
const crypto = require('crypto');

const LRCLIB_UA = 'Syntune/1.0.0 ( https://github.com/  marcoxpg2@gmail.com )';

async function lrclibGet(artist, title, album, duration) {
  const p = new URLSearchParams({
    artist_name: artist || '', track_name: title || '',
    album_name: album || '', duration: String(Math.round(duration || 0))
  });
  const r = await fetch(`https://lrclib.net/api/get?${p.toString()}`, { headers: { 'User-Agent': LRCLIB_UA } });
  if (!r.ok) return null;
  return r.json();
}
async function lrclibSearch(artist, title) {
  const p = new URLSearchParams({ track_name: title || '', artist_name: artist || '' });
  const r = await fetch(`https://lrclib.net/api/search?${p.toString()}`, { headers: { 'User-Agent': LRCLIB_UA } });
  if (!r.ok) return [];
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}

// detecta tags de tempo [mm:ss.xx] de uma letra sincronizada (LRC)
function isSyncedLyricsText(text) {
  return !!(text && /\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(text));
}

// busca no LRCLIB: tenta /get exato (com duração) e cai para /search
async function fetchLrclib({ artist, title, album, duration } = {}) {
  if (!title && !artist) return { synced: null, plain: null };
  let hit = null;
  if (duration && duration > 0) {
    try { hit = await lrclibGet(artist, title, album, duration); } catch { /* tenta busca */ }
  }
  if (!hit || (!hit.syncedLyrics && !hit.plainLyrics)) {
    try {
      const results = await lrclibSearch(artist, title);
      if (results.length) hit = results.find((x) => x.syncedLyrics) || results[0];
    } catch { /* sem resultado */ }
  }
  if (!hit) return { synced: null, plain: null };
  return { synced: hit.syncedLyrics || null, plain: hit.plainLyrics || null };
}

// Proof-of-work exigido p/ publicar no LRCLIB: acha um nonce cujo sha256(prefix+nonce)
// seja <= target. O algoritmo (sha256) é imposição do serviço.
async function solveLrclibChallenge() {
  try {
    const res = await fetch('https://lrclib.net/api/request-challenge', { method: 'POST' });
    const data = await res.json();
    const prefix = data.prefix;
    const target = data.target.toLowerCase();
    let nonce = 0;
    while (nonce < 20000000) {
      const hash = crypto.createHash('sha256').update(prefix + String(nonce)).digest('hex');
      if (hash <= target) {
        return prefix + ':' + nonce;
      }
      nonce++;
    }
  } catch (err) {
    console.error('LRCLIB Challenge Error:', err);
  }
  return null;
}

module.exports = { lrclibGet, lrclibSearch, isSyncedLyricsText, fetchLrclib, solveLrclibChallenge };

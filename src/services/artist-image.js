/**
 * @module  services/artist-image
 * @badge   🟦 SERVICE · NETWORK · FS-CACHE · RATE-LIMITED(Genius ~400ms) · STATEFUL
 * @role    Foto do artista via Genius: resolve com cache em disco (userData/artists/), migra formato legado e baixa a imagem; devolve URL mp3artist://.
 * @inputs  { name, token, noArtistLabel }
 * @outputs { url } | { url:null } | { url, cached } | { url:null, noToken } | { url:null, error }
 * @deps    fs, path, electron(app), ./metadata-sources (fuzzyMatch/normName), global fetch
 * @notes   artists.json guarda só metadados; bytes ficam em disco (servidos por mp3artist://). Throttle Genius privado.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { fuzzyMatch, normName } = require('./metadata-sources');

const GENIUS_UA = 'Syntune/1.0 ( syntune app; marcoxpg2@gmail.com )';

const ARTISTS_PATH = () => path.join(app.getPath('userData'), 'artists.json');
const ARTISTS_DIR = () => path.join(app.getPath('userData'), 'artists');

function readArtistsCache() {
  try { return JSON.parse(fs.readFileSync(ARTISTS_PATH(), 'utf-8')) || {}; } catch { return {}; }
}
function writeArtistsCache(c) {
  try { fs.writeFileSync(ARTISTS_PATH(), JSON.stringify(c, null, 2), 'utf-8'); } catch { /* best-effort */ }
}

// nome de arquivo seguro a partir da chave normalizada do artista
function artistFileName(key, mime) {
  const base = key.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'artist';
  return base + (mime === 'image/png' ? '.png' : '.jpg');
}

// grava os bytes da foto em disco e devolve a URL do protocolo
function saveArtistPhoto(key, buf, mime, at) {
  const dir = ARTISTS_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const file = artistFileName(key, mime);
  fs.writeFileSync(path.join(dir, file), buf);
  return { file, url: `mp3artist://${encodeURIComponent(file)}?v=${at}` };
}

// serializa as chamadas ao Genius (~400ms entre elas)
let geniusChain = Promise.resolve();
let geniusLast = 0;
function geniusThrottle() {
  const result = geniusChain.then(async () => {
    const wait = Math.max(0, 400 - (Date.now() - geniusLast));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    geniusLast = Date.now();
  });
  geniusChain = result.catch(() => {});
  return result;
}

// busca a URL da foto do artista no Genius (casa o nome; senão, 1º resultado)
async function geniusArtistImage(name, token) {
  const url = `https://api.genius.com/search?q=${encodeURIComponent(name)}`;
  await geniusThrottle();
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': GENIUS_UA } });
  if (!r.ok) return null;
  const data = await r.json();
  const hits = (data && data.response && data.response.hits) || [];
  const pickImg = (a) => (a && (a.image_url || a.header_image_url)) || null;
  for (const h of hits) {
    const a = h.result && h.result.primary_artist;
    if (a && fuzzyMatch(a.name, name) && pickImg(a)) return pickImg(a);
  }
  const a0 = hits[0] && hits[0].result && hits[0].result.primary_artist;
  return pickImg(a0);
}

// Resolução completa: cache-first → migração legado → fetch Genius → salva.
// `token` pode vir vazio: só é exigido quando há necessidade de buscar online.
async function resolveArtistImage({ name, token, noArtistLabel } = {}) {
  const key = normName(name);
  // placeholders de "artista desconhecido" em qualquer idioma da UI não vão ao Genius
  const skip = new Set(['sem artista', 'desconhecido', 'no artist', 'unknown', normName(noArtistLabel)]);
  if (!key || skip.has(key)) return { url: null };

  const cache = readArtistsCache();
  const hit = cache[key];

  // migração do formato legado: dataUrl embutida no JSON -> arquivo em disco
  if (hit && hit.dataUrl) {
    try {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(hit.dataUrl);
      if (m) {
        const saved = saveArtistPhoto(key, Buffer.from(m[2], 'base64'), m[1], hit.at || Date.now());
        cache[key] = { name: hit.name || name, url: hit.url || null, file: saved.file, tried: true, at: hit.at || Date.now() };
        writeArtistsCache(cache);
        return { url: saved.url, cached: true };
      }
    } catch { /* migração falhou: rebusca abaixo */ }
    delete hit.dataUrl;
  }

  if (hit && hit.file && fs.existsSync(path.join(ARTISTS_DIR(), hit.file))) {
    return { url: `mp3artist://${encodeURIComponent(hit.file)}?v=${hit.at || 0}`, cached: true };
  }
  if (hit && hit.tried && !hit.url) return { url: null }; // já tentou e não achou

  const tok = (token || '').trim();
  if (!tok) return { url: null, noToken: true };

  try {
    let imgUrl = hit && hit.url;
    if (!imgUrl) imgUrl = await geniusArtistImage(name, tok);
    if (!imgUrl) {
      cache[key] = { name, url: null, tried: true, at: Date.now() };
      writeArtistsCache(cache);
      return { url: null };
    }
    const ir = await fetch(imgUrl, { headers: { 'User-Agent': GENIUS_UA } });
    if (!ir.ok) return { url: null };
    const ct = (ir.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!ct.startsWith('image/')) return { url: null };
    const buf = Buffer.from(await ir.arrayBuffer());
    const at = Date.now();
    const saved = saveArtistPhoto(key, buf, ct, at);
    cache[key] = { name, url: imgUrl, file: saved.file, tried: true, at };
    writeArtistsCache(cache);
    return { url: saved.url };
  } catch (err) {
    return { url: null, error: err.message };
  }
}

module.exports = { resolveArtistImage, geniusArtistImage, readArtistsCache, writeArtistsCache, saveArtistPhoto, ARTISTS_DIR };

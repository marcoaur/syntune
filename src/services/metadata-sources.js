/**
 * @module  services/metadata-sources
 * @badge   🟦 SERVICE · NETWORK · RATE-LIMITED(MB 1.1s) · STATELESS-API
 * @role    Factual music metadata from MusicBrainz + iTunes: search, rank, consolidate facts, high-res cover, artist/title parse, prompt facts block.
 * @inputs  artist/title seeds, fact objects
 * @outputs match arrays, consolidated fact object, cover data URL|null, strings
 * @deps    global fetch, ../../i18n (t)
 * @notes   Module-private MusicBrainz throttle (mbChain/mbLast, ~1.1s spacing). No app config needed.
 */
const i18n = require('../../i18n');
const t = i18n.t;

// ---------- MusicBrainz ----------
const MB_UA = 'Syntune/1.0 ( syntune app; marcoxpg2@gmail.com )';
// throttle privado: 1 req a cada ~1.1s (regra do MusicBrainz)
let mbChain = Promise.resolve();
let mbLast = 0;

function mbThrottle() {
  const result = mbChain.then(async () => {
    const wait = Math.max(0, 1100 - (Date.now() - mbLast));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    mbLast = Date.now();
  });
  mbChain = result.catch(() => {});
  return result;
}

// remove caracteres especiais do Lucene p/ montar a query com segurança
function luceneSafe(s) {
  return String(s || '').replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function mbFetch(query) {
  const url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=8`;
  await mbThrottle();
  const r = await fetch(url, { headers: { 'User-Agent': MB_UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(t('main.mbUnavailable', { status: r.status }));
  return r.json();
}

// Faz duas buscas e mescla: uma REFINADA (só álbum oficial de estúdio — melhor para
// faixas muito regravadas/ao vivo) e a SIMPLES (melhor para faixas diretas). O
// ranking por qualidade+ano em mbToMatches escolhe o melhor do conjunto unido.
async function mbSearchRecordings(artist, title) {
  const parts = [];
  if (title) parts.push(`recording:"${luceneSafe(title)}"`);
  if (artist) parts.push(`artist:"${luceneSafe(artist)}"`);
  const base = parts.join(' AND ') || luceneSafe(title) || luceneSafe(artist);
  const refined = base + ' AND primarytype:album AND status:official AND -secondarytype:compilation AND -secondarytype:live';

  const results = [];
  for (const q of [refined, base]) {
    try { results.push(await mbFetch(q)); } catch (e) { if (!results.length) throw e; }
  }
  const recs = [];
  const seen = new Set();
  for (const data of results) {
    for (const rec of (Array.isArray(data.recordings) ? data.recordings : [])) {
      if (rec && rec.id && !seen.has(rec.id)) { seen.add(rec.id); recs.push(rec); }
    }
  }
  return { recordings: recs };
}

// de um "recording", escolhe a melhor release: prefere álbum de ESTÚDIO oficial
// (penaliza coletânea/ao vivo/trilha) e, em empate, a data mais antiga.
function bestReleaseOf(rec) {
  const rels = Array.isArray(rec.releases) ? rec.releases : [];
  const scored = rels.map((rel) => {
    const rg = rel['release-group'] || {};
    const primaryType = (rg['primary-type'] || '').toLowerCase();
    const status = (rel.status || '').toLowerCase();
    const secs = (rg['secondary-types'] || []).map((x) => String(x).toLowerCase());
    let s = 0;
    if (primaryType === 'album') s += 3;
    if (status === 'official') s += 2;
    if (secs.includes('compilation')) s -= 3;
    if (secs.includes('live')) s -= 3;
    if (secs.includes('soundtrack') || secs.includes('dj-mix')) s -= 1;
    if (primaryType === 'album' && !secs.length) s += 2; // álbum de estúdio puro
    let trackNumber = '', totalTracks = '';
    const media = Array.isArray(rel.media) ? rel.media[0] : null;
    if (media) {
      totalTracks = media['track-count'] ? String(media['track-count']) : '';
      const tr = Array.isArray(media.track) ? media.track[0] : null;
      if (tr && tr.number) trackNumber = String(tr.number);
    }
    return { rel, s, trackNumber, totalTracks };
  });
  scored.sort((a, b) => b.s - a.s ||
    String(a.rel.date || '9999').localeCompare(String(b.rel.date || '9999')));
  return scored[0] || null;
}

function mbCreditToName(credit) {
  if (!Array.isArray(credit)) return '';
  return credit.map((c) => (c.name || (c.artist && c.artist.name) || '') + (c.joinphrase || '')).join('').trim();
}

function mbToMatches(data) {
  const recs = Array.isArray(data.recordings) ? data.recordings : [];
  const out = [];
  for (const rec of recs.slice(0, 8)) {
    const best = bestReleaseOf(rec);
    const rel = best ? best.rel : null;
    out.push({
      title: rec.title || '',
      artist: mbCreditToName(rec['artist-credit']),
      album: rel ? (rel.title || '') : '',
      year: rel && rel.date ? String(rel.date).slice(0, 4) : '',
      trackNumber: best ? best.trackNumber : '',
      totalTracks: best ? best.totalTracks : '',
      releaseMbid: rel ? rel.id : '',
      score: Number(rec.score) || 0,
      _q: best ? best.s : -99
    });
  }
  // ordena por qualidade da release (estúdio oficial primeiro), depois ano mais
  // antigo (lançamento original) e, por fim, o score textual do MusicBrainz.
  out.sort((a, b) => (b._q - a._q) ||
    (Number(a.year || 9999) - Number(b.year || 9999)) || (b.score - a.score));

  const seen = new Set();
  const deduped = out.filter((m) => {
    const k = `${m.title}|${m.artist}|${m.album}|${m.year}`.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  deduped.forEach((m) => { delete m._q; });
  return deduped.slice(0, 6);
}

// ---------- iTunes Search API (gênero, ano, faixa e capa em alta) ----------
function normName(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
// match aproximado: igual ou um contém o outro (ignora acentos/pontuação)
function fuzzyMatch(a, b) {
  a = normName(a); b = normName(b);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

async function itunesLookup(artist, title) {
  const term = encodeURIComponent(`${artist || ''} ${title || ''}`.trim());
  if (!term) return null;
  const url = `https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=5`;
  const r = await fetch(url, { headers: { 'User-Agent': MB_UA } });
  if (!r.ok) return null;
  const data = await r.json();
  const results = Array.isArray(data.results) ? data.results : [];
  if (!results.length) return null;
  // prefere o que casa artista E título; senão, o primeiro
  const best = results.find((x) => fuzzyMatch(x.artistName, artist) && fuzzyMatch(x.trackName, title))
    || results[0];
  const artwork = (best.artworkUrl100 || best.artworkUrl60 || '').replace(/\/\d+x\d+bb\./, '/600x600bb.');
  return {
    artist: best.artistName || '',
    title: best.trackName || '',
    album: best.collectionName || '',
    year: best.releaseDate ? String(best.releaseDate).slice(0, 4) : '',
    genre: best.primaryGenreName || '',
    trackNumber: best.trackNumber ? String(best.trackNumber) : '',
    totalTracks: best.trackCount ? String(best.trackCount) : '',
    artworkUrl: artwork
  };
}

// Consulta as fontes factuais (MusicBrainz + iTunes) a partir de uma semente
// artista/título. Cada fonte traz um flag de confiança (casou artista e título).
async function gatherFacts(seedArtist, seedTitle) {
  const facts = { sources: [] };
  if (!seedArtist && !seedTitle) return facts;

  try {
    const matches = mbToMatches(await mbSearchRecordings(seedArtist, seedTitle));
    const top = matches[0];
    if (top) {
      top.confident = fuzzyMatch(top.artist, seedArtist) && fuzzyMatch(top.title, seedTitle);
      facts.musicbrainz = top;
      facts.sources.push('MusicBrainz');
    }
  } catch { /* segue sem MB */ }

  try {
    const it = await itunesLookup(seedArtist, seedTitle);
    if (it) {
      it.confident = fuzzyMatch(it.artist, seedArtist) && fuzzyMatch(it.title, seedTitle);
      facts.itunes = it;
      facts.sources.push('iTunes');
    }
  } catch { /* segue sem iTunes */ }

  return facts;
}

// Consolida os fatos: álbum/ano/faixa preferem MusicBrainz; gênero vem do iTunes.
// Marca confiança alta se ao menos uma fonte casou artista+título.
function consolidateFacts(facts) {
  const mb = facts.musicbrainz, it = facts.itunes;
  const mbC = mb && mb.confident, itC = it && it.confident;
  const first = (...vals) => vals.find((v) => v) || '';
  // ano: prefere o MAIS ANTIGO entre as fontes confiáveis (lançamento original,
  // não uma reedição). Cai para qualquer ano disponível se nenhuma for confiável.
  const confYears = [mbC && mb.year, itC && it.year].filter(Boolean).map(Number).filter((y) => y > 1000);
  const year = confYears.length ? String(Math.min(...confYears)) : first(mb && mb.year, it && it.year);
  return {
    artist: first(mbC && mb.artist, itC && it.artist, mb && mb.artist, it && it.artist),
    title: first(mbC && mb.title, itC && it.title, mb && mb.title, it && it.title),
    album: first(mbC && mb.album, itC && it.album, mb && mb.album, it && it.album),
    year,
    trackNumber: first(mbC && mb.trackNumber, itC && it.trackNumber, mb && mb.trackNumber, it && it.trackNumber),
    genre: first(itC && it.genre, it && it.genre),
    releaseMbid: mb ? (mb.releaseMbid || '') : '',
    artworkUrl: it ? (it.artworkUrl || '') : '',
    confident: !!(mbC || itC),
    sources: facts.sources
  };
}

// Capa em alta: tenta o Cover Art Archive (por MBID) e depois o artwork do iTunes.
async function fetchFactualCover(c) {
  if (!c) return null;
  const tryUrl = async (url) => {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': MB_UA }, redirect: 'follow' });
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
      if (!ct.startsWith('image/')) return null;
      return `data:${ct};base64,${buf.toString('base64')}`;
    } catch { return null; }
  };
  if (c.releaseMbid) {
    const caa = await tryUrl(`https://coverartarchive.org/release/${encodeURIComponent(c.releaseMbid)}/front-500`);
    if (caa) return caa;
  }
  if (c.artworkUrl) {
    const it = await tryUrl(c.artworkUrl);
    if (it) return it;
  }
  return null;
}

// descritores de vídeo que NÃO fazem parte de artista/título — removidos antes do parse
// (cobrem os casos "... | Lyric Video", "(Official Video)", "[Clipe Oficial]" etc.)
const VIDEO_JUNK = /\b(official\s*music\s*video|official\s*video|music\s*video|lyric[s]?\s*video|video\s*lyric[s]?|lyric[s]?|official\s*audio|audio\s*oficial|v[ií]deo\s*oficial|clipe\s*oficial|clipe|visualizer|legendado|official|full\s*hd|hd|hq|4k|mv|m\/v)\b/gi;

// Capitaliza nomes vindos da HEURÍSTICA (título cru do YouTube/arquivo), que vêm
// em CAIXA ALTA / minúsculas inconsistentes (ex.: "LIVRE ACESS"). NÃO aplicar a
// nomes vindos das APIs factuais (MusicBrainz/iTunes) nem do Gemini — esses já
// trazem a grafia correta.
function titleCase(s) {
  return String(s || '')
    .toLocaleLowerCase('pt-BR')
    .replace(/(^|[\s\-–—|·•/("'’])(\p{L})/gu, (_m, sep, ch) => sep + ch.toLocaleUpperCase('pt-BR'));
}

// extrai "Artista - Título" de um título de vídeo/arquivo (heurística).
// channelHint (canal/uploader do YouTube) desambigua a ORDEM quando o separador
// é ambíguo (ex.: "Faixa | Artista"): o segmento que casa com o canal é o artista.
function parseArtistTitle(s, channelHint) {
  const cleaned = String(s || '')
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ') // remove (...) [...] {...}
    .replace(VIDEO_JUNK, ' ')                        // remove descritores de vídeo
    .replace(/\s+/g, ' ')
    .trim();

  // 1º tenta " - " (padrão Artista - Título); senão | · • (ordem ambígua)
  let parts = cleaned.split(/\s[-–—]\s/);
  if (parts.length < 2) parts = cleaned.split(/\s*[|·•]\s*/);
  parts = parts.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);

  if (parts.length < 2) return { artist: '', title: titleCase(parts[0] || cleaned) };

  let artist = parts[0];
  let title = parts.slice(1).join(' - ');
  // ordem ambígua: se o canal casa com o ÚLTIMO segmento (e não com o 1º), inverte
  if (channelHint) {
    const matchFirst = fuzzyMatch(parts[0], channelHint);
    const matchLast = fuzzyMatch(parts[parts.length - 1], channelHint);
    if (matchLast && !matchFirst) {
      artist = parts[parts.length - 1];
      title = parts.slice(0, -1).join(' - ');
    }
  }
  return { artist: titleCase(artist), title: titleCase(title) };
}

// monta o bloco de fatos p/ os prompts do Gemini
function factsBlock(c) {
  if (!c || (!c.album && !c.year && !c.genre && !c.trackNumber && !c.artist && !c.title)) {
    return '(nenhum dado factual encontrado nas APIs de música)';
  }
  return [
    `- Fontes consultadas: ${(c.sources || []).join(', ') || '(nenhuma)'}`,
    `- Confiança do match: ${c.confident ? 'ALTA' : 'baixa'}`,
    `- Artista: ${c.artist || '(?)'}`,
    `- Título: ${c.title || '(?)'}`,
    `- Álbum: ${c.album || '(?)'}`,
    `- Ano de lançamento: ${c.year || '(?)'}`,
    `- Número da faixa: ${c.trackNumber || '(?)'}`,
    `- Gênero (iTunes): ${c.genre || '(?)'}`
  ].join('\n');
}

module.exports = { mbSearchRecordings, mbToMatches, itunesLookup, gatherFacts, consolidateFacts, fetchFactualCover, parseArtistTitle, titleCase, factsBlock, fuzzyMatch, normName };

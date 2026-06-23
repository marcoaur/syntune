// ===================== Módulos puros (ESM) =====================
// Helpers sem estado, extraídos do monolito. Ver renderer/modules/*.js e AGENTS.md.
import { normPart, keyOf, normalizeText, artistInitials, escapeHtmlText, cssEsc, fmtBytes, fmtDb } from './modules/format.js';
import { rgbToHsl, hslToRgb, deriveBarColors, lerpPal } from './modules/color.js';
import { isSyncedLyrics, parseLrc, lrcToPlain, parseLrcTime, fmtTimestamp, parseLrcSeconds, parseLyricsToLines, serializeLines } from './modules/lrc.js';
import { LYRICS_STATUS, EQ_BANDS, EQ_BUILTINS } from './modules/constants.js';
import { ICONS } from './modules/icons.js';

// Camada Lit (ilhas + folhas): import ESTÁTICO → registra todos os custom elements
// (customElements.define) durante o eval deste módulo, ANTES do 1º render/DOMContentLoaded.
// Seguro pós-Fase F: o renderer roda SEMPRE bundlado (electron-vite), onde `import 'lit'`
// resolve. Não há mais fallback legado — os custom elements estão sempre registrados.
import './components/index.js';

// O main resolve o idioma (locale do sistema + cache em config.json) e entrega
// o dicionário pronto. t() traduz chaves; tn() escolhe singular/plural;
// applyStaticI18n() aplica as traduções nos elementos estáticos do HTML
// (data-i18n / data-i18n-html / data-i18n-title / data-i18n-placeholder).
let STR = {};
// Race com timeout de 3 s: se o IPC travar, não bloqueia o startup
const _i18nFetch = window.api.getI18n().then((r) => {
  STR = (r && r.strings) || {};
  if (r && r.lang) document.documentElement.lang = r.lang;
}).catch(() => { /* sem dicionário: as chaves caem no texto da própria chave */ });
const i18nReady = Promise.race([
  _i18nFetch,
  new Promise((res) => setTimeout(res, 3000)) // fallback: segue mesmo sem strings
]);

function t(key, vars) {
  let s = STR[key] != null ? STR[key] : key;
  if (vars) {
    for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
  }
  return s;
}
function tn(key, n) { return t(key + (Math.abs(n) === 1 ? '.one' : '.many'), { n }); }

function applyStaticI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
}

// ====================== Estado ======================
let songs = [];          // itens da biblioteca (vindos do disco)
let pendingJobs = [];    // downloads/enriquecimentos em andamento (transientes)

// Sincronização com dispositivo
let activeDevice = null;        // { serial, ... } dispositivo conectado + sync ligada
let syncedKeys = new Set();     // keys (nome|artista|ano) sincronizadas no dispositivo de referência
let hasSyncContext = false;     // há um dispositivo de referência p/ exibir badges de sync?
let deviceOnlySongs = [];       // faixas que só existem no dispositivo (entram na lista)
let showingIgnored = false;     // sheet de dispositivos: lista de ignorados visível?

// Busca / agrupamento
let searchQuery = '';
let groupBy = false;                  // agrupar por artista (com subcabeçalho de álbum)
let collapsedArtists = new Set();     // artistas com a seção recolhida
// cascata de entrada dos cards: só em mudanças intencionais de visão (carga
// inicial, busca, agrupamento). Re-renders de fundo (sync de dispositivo,
// jobs) não devem "piscar" a lista re-animando tudo.
let listEntrance = true;

// Player
let visibleList = [];           // lista ordenada renderizada (base da fila)
let queue = [];                 // fila de reprodução atual
let queueIndex = -1;            // índice da faixa atual na fila
let current = null;             // faixa em reprodução
let isPlaying = false;
let shuffle = false;
let repeatMode = 'off';         // 'off' | 'all' | 'one'

// Editor (música aberta para edição)
let currentFilePath = null;
let currentEditorSong = null;    // referência da faixa aberta (p/ visualização/play)
let currentImagePath = null;     // caminho local (capa não recortada)
let currentImageDataUrl = null;  // imagem final já enquadrada (quadrada) p/ gravar
let coverSourceDataUrl = null;   // imagem-fonte (thumb ou local) p/ reabrir o cropper
let currentYtContext = null;     // contexto rico do YouTube (edição vinda do add)

// ====================== Capas via protocolo mp3cover:// ======================
// As capas são servidas pelo protocolo nativo e vivem no cache de imagens do
// Chromium (com eviction automática) — nada de base64 no heap JS.
// coverState memoriza apenas o RESULTADO: true (tem capa) | false (sem capa).
const coverState = new Map();

function coverUrl(s) {
  return 'mp3cover://' + encodeURIComponent(s.filePath) + '?v=' + (s.mtime || 0);
}

// ====================== Atalhos DOM ======================
const $ = (id) => document.getElementById(id);
const fields = ['title', 'artist', 'album', 'albumArtist', 'composer', 'year',
  'genre', 'trackNumber', 'partOfSet', 'publisher', 'comment', 'lyrics', 'chords'];

// chave de identidade da faixa (espelha syncKey do main): nome|artista|ano

// ====================== Controles da janela ======================
$('btnClose').addEventListener('click', () => window.api.close());
$('btnMin').addEventListener('click', () => window.api.minimize());

// ====================== Toast ======================
let toastTimer;
let toastHideTimer;
function toast(message, type = '') {
  // ilha Lit ativa (bundle): delega ao ToastService (syn-toast renderiza). Fallback legado abaixo.
  if (_litToast) { _litToast.toast(message, type); return; }
  const el = $('toast');
  const icon = type === 'success' ? '✓' : (type === 'error' ? '!' : '♪');
  el.innerHTML = `<span class="toast-ic">${icon}</span><span class="toast-msg"></span>`;
  el.querySelector('.toast-msg').textContent = message;
  el.className = `toast ${type}`;
  // flutua acima do mini-player quando ele está visível
  el.style.bottom = $('player').classList.contains('hidden') ? '24px' : '108px';
  void el.offsetWidth; // reinicia a animação de entrada em toasts consecutivos
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  toastTimer = setTimeout(() => {
    el.classList.add('leaving');
    toastHideTimer = setTimeout(() => el.classList.add('hidden'), 260);
  }, 3200);
}

// aviso do main: cofre de chaves do SO indisponível — segredos em plaintext
window.api.onSecurityWarning(() => toast(t('security.plaintextWarning'), 'error'));

// update baixado: badge na titlebar; clique fecha e instala a nova versão agora
window.api.onUpdateReady((info) => {
  const b = $('updateBadge');
  if (!b) return;
  const v = (info && info.version) ? 'v' + info.version : '';
  b.textContent = t('update.badge', { v });
  b.title = t('update.badgeTitle', { v });
  b.classList.remove('hidden');
  b.onclick = () => {
    b.disabled = true;
    b.textContent = t('update.installing');
    window.api.installUpdate();
  };
});

// ====================== Overlay de carregamento ======================
function showLoading(msg) {
  $('loadingMsg').textContent = msg || t('common.loading');
  $('loadingOverlay').classList.remove('hidden', 'closing');
}
function hideLoading() { $('loadingOverlay').classList.add('hidden'); }
const paint = () => new Promise((r) => requestAnimationFrame(() => r()));

// Fecha uma tela/overlay com animação de saída (sem corte seco): aplica .closing,
// espera a animação do PRÓPRIO elemento (ignora animationend de filhos) e só então
// esconde. Fallback por timeout caso a animação não dispare.
function closeViewAnimated(el, done) {
  if (!el || el.classList.contains('hidden') || el.classList.contains('closing')) return;
  el.classList.add('closing');
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    el.removeEventListener('animationend', onEnd);
    if (!el.classList.contains('closing')) return; // reaberto durante o fechamento
    el.classList.remove('closing');
    el.classList.add('hidden');
    if (done) done();
  };
  const onEnd = (e) => { if (e.target === el) finish(); };
  el.addEventListener('animationend', onEnd);
  setTimeout(finish, 360);
}

// ====================== Imagens / paleta ======================
function loadImage(src, crossOrigin) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = 'anonymous'; // p/ getImageData sem taint
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// recorte centralizado "cover" -> data URL quadrado
async function makeCenterCrop(src, out = 640) {
  const img = await loadImage(src);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = out; canvas.height = out;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, sx, sy, side, side, 0, 0, out, out);
  return canvas.toDataURL('image/jpeg', 0.92);
}

// Extrai a cor-chave (dominante e vibrante) de uma capa, p/ tingir o card.
const paletteCache = new Map();
async function getPalette(dataUrl) {
  if (!dataUrl) return null;
  if (paletteCache.has(dataUrl)) return paletteCache.get(dataUrl);

  let pal = null;
  try {
    // URLs de protocolo custom precisam de CORS p/ getImageData; data URLs não.
    // Se a carga CORS falhar, tenta sem (a paleta pode falhar no taint, mas é
    // capturada pelo catch e vira null — nada quebra).
    const needsCors = !dataUrl.startsWith('data:');
    let img;
    try { img = await loadImage(dataUrl, needsCors); }
    catch { img = await loadImage(dataUrl); }
    const S = 32;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, S, S);
    const { data } = ctx.getImageData(0, 0, S, S);

    // quantiza em baldes e pondera por saturação para achar a cor "chave"
    const buckets = new Map();
    let avgR = 0, avgG = 0, avgB = 0, avgN = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 125) continue;
      avgR += r; avgG += g; avgB += b; avgN++;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum < 28 || lum > 232) continue; // ignora quase preto/branco
      const key = `${r >> 5},${g >> 5},${b >> 5}`;
      const prev = buckets.get(key) || { r: 0, g: 0, b: 0, w: 0 };
      const w = 1 + sat * 3; // valoriza cores saturadas
      prev.r += r * w; prev.g += g * w; prev.b += b * w; prev.w += w;
      buckets.set(key, prev);
    }

    let best = null;
    for (const v of buckets.values()) {
      if (!best || v.w > best.w) best = v;
    }
    let r, g, b;
    if (best) {
      r = Math.round(best.r / best.w);
      g = Math.round(best.g / best.w);
      b = Math.round(best.b / best.w);
    } else if (avgN) {
      r = Math.round(avgR / avgN); g = Math.round(avgG / avgN); b = Math.round(avgB / avgN);
    }
    if (r != null) {
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      pal = { r, g, b, text: lum > 150 ? '#1d1d1f' : '#ffffff' };
    }
  } catch { /* sem paleta */ }

  paletteCache.set(dataUrl, pal);
  return pal;
}

// expõe a cor-chave da capa no card (--cv); o CSS aplica o acento por estado
async function applyPalette(card, dataUrl) {
  const pal = await getPalette(dataUrl);
  if (!pal) return;
  card.style.setProperty('--cv', `${pal.r}, ${pal.g}, ${pal.b}`);
}

// onda de cor que nasce do elemento clicado e inunda a tela ao iniciar uma faixa
function spawnPlayBurst(el) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  const d = Math.max(window.innerWidth, window.innerHeight) * 1.7;
  const b = document.createElement('div');
  b.className = 'play-burst';
  const cv = el.style.getPropertyValue('--cv');
  if (cv) b.style.setProperty('--cv', cv);
  b.style.left = (r.left + r.width / 2) + 'px';
  b.style.top = (r.top + r.height / 2) + 'px';
  b.style.width = b.style.height = d + 'px';
  document.body.appendChild(b);
  b.addEventListener('animationend', () => b.remove());
}

// flare no ambiente da biblioteca quando uma nova faixa começa
function flareAmbient() {
  const amb = $('libAmbient');
  if (!amb) return;
  amb.classList.remove('flare');
  void amb.offsetWidth; // reinicia a animação
  amb.classList.add('flare');
}

// ====================== Biblioteca: carregar e renderizar ======================
function sortSongs(list) {
  const k = (s, f) => (s[f] || '').toString().toLowerCase();
  return list.slice().sort((a, b) =>
    k(a, 'artist').localeCompare(k(b, 'artist'), t('meta.locale')) ||
    (a.year || '').localeCompare(b.year || '', t('meta.locale')) ||
    k(a, 'album').localeCompare(k(b, 'album'), t('meta.locale')) ||
    k(a, 'title').localeCompare(k(b, 'title'), t('meta.locale'))
  );
}

async function reloadLibrary() {
  try {
    // Timeout de 10 s: se a leitura da pasta travar (rede, pendrive removido etc.),
    // não bloqueia o startup — a biblioteca fica vazia e o splash é removido normalmente.
    const timeoutPromise = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('library:list timeout')), 10000)
    );
    const res = await Promise.race([window.api.libraryList(), timeoutPromise]);
    songs = (res && res.items) || [];
  } catch (err) {
    console.warn('[reloadLibrary]', err.message || err);
    songs = [];
  }
  renderList();
}

function songSubtitle(s) {
  const parts = [];
  if (s.artist) parts.push(s.artist);
  if (s.year) parts.push(s.year);
  return parts.join(' · ') || t('library.noInfo');
}

// normaliza p/ busca: minúsculas e sem acentos (bom p/ português)
// casa todos os termos (AND) em título + artista + álbum
function matchesQuery(s, terms) {
  if (!terms.length) return true;
  const hay = normalizeText(`${s.title || ''} ${s.artist || ''} ${s.album || ''}`);
  return terms.every((t) => hay.includes(t));
}
function artistKeyOf(s) { return (s.artist || '').trim() || t('library.noArtist'); }

// Faixa de demonstração semeada (artista "Syntune" + álbum "Demo") — contrato com o
// asset em assets/demo/. Ao clicá-la, o app abre direto no modo imersivo + karaokê
// (o "primeiro uau"). Some quando o usuário a substitui/apaga.
function isDemoTrack(s) { return !!s && s.artist === 'Syntune' && s.album === 'Demo'; }

function renderList() {
  const list = $('songList');
  list.innerHTML = '';
  // consome o "ticket" de animação: sem ele, os cards entram estáticos
  list.classList.toggle('no-entrance', !listEntrance);
  listEntrance = false;

  // jobs em andamento aparecem no topo
  for (const job of pendingJobs) list.appendChild(buildPendingCard(job));

  // músicas da biblioteca + faixas que só existem no dispositivo, filtradas pela busca
  const all = songs.concat(deviceOnlySongs);
  const terms = normalizeText(searchQuery).split(/\s+/).filter(Boolean);
  const filtered = terms.length ? all.filter((s) => matchesQuery(s, terms)) : all;
  const sorted = sortSongs(filtered);
  visibleList = sorted; // base da fila de reprodução (na ordem exibida)

  if (groupBy) renderGenreShelves(list, sorted);
  else {
    // cascata de entrada: cada card chega com um pequeno atraso escalonado
    let i = 0;
    for (const s of sorted) {
      const card = buildSongCard(s);
      card.style.setProperty('--i', String(Math.min(i++, 24)));
      list.appendChild(card);
    }
  }

  // busca/agrupar só fazem sentido com biblioteca; o adicionar fica sempre disponível
  const hasLib = all.length > 0;
  $('searchBox').classList.toggle('hidden', !hasLib);
  $('groupToggle').classList.toggle('hidden', !hasLib);
  const empty = pendingJobs.length === 0 && all.length === 0;
  const noResults = all.length > 0 && sorted.length === 0;
  $('emptyState').classList.toggle('hidden', !empty);
  $('noResults').classList.toggle('hidden', !noResults);

  refreshToolbarStatus();

  // remonta o visualizador no card que está tocando (cards foram recriados)
  markPlayingCards();
}

// iniciais do artista para o avatar (placeholder)

const globalPlaycountCache = {};   // artist + "-" + title -> { playcount, listeners, tags } | null
const globalPlaycountPending = {}; // artist + "-" + title -> Promise

function formatPlaycount(numStr) {
  const num = parseInt(numStr, 10);
  if (isNaN(num)) return null;
  if (num >= 1000000) {
    const val = num / 1000000;
    return val >= 10 ? Math.round(val) + 'M' : val.toFixed(1).replace('.', t('meta.decimal')) + 'M';
  }
  if (num >= 1000) {
    const val = num / 1000;
    return val >= 10 ? Math.round(val) + 'K' : val.toFixed(1).replace('.', t('meta.decimal')) + 'K';
  }
  return num.toString();
}

async function fetchGlobalPlaycount(artist, title) {
  const normArtist = (artist || '').trim().toLowerCase();
  const normTitle = (title || '').trim().toLowerCase();
  if (!normArtist || !normTitle) return null;
  const k = `${normArtist} - ${normTitle}`;

  if (globalPlaycountCache[k] !== undefined) return globalPlaycountCache[k];
  if (globalPlaycountPending[k]) return globalPlaycountPending[k];

  globalPlaycountPending[k] = window.api.lastfmGetPlaycount({ artist, title })
    .then((r) => {
      globalPlaycountCache[k] = r || null;
      return globalPlaycountCache[k];
    })
    .catch(() => {
      globalPlaycountCache[k] = null;
      return null;
    })
    .finally(() => {
      delete globalPlaycountPending[k];
    });

  return globalPlaycountPending[k];
}

// busca a foto do artista (Genius) de forma lazy, com cache em memória + dedupe
const artistImgCache = {};   // normArtist -> URL mp3artist:// (string curta) | null
const artistImgPending = {}; // normArtist -> Promise
async function fillArtistAvatar(el, name) {
  const k = normPart(name);
  if (!k) return;
  const apply = (url) => { if (url) el.innerHTML = `<img src="${url}" alt="" />`; };
  if (artistImgCache[k] !== undefined) { apply(artistImgCache[k]); return; }
  if (!artistImgPending[k]) {
    artistImgPending[k] = window.api.artistImage({ name })
      .then((r) => { artistImgCache[k] = (r && (r.url || r.dataUrl)) || null; return artistImgCache[k]; })
      .catch(() => { artistImgCache[k] = null; return null; })
      .finally(() => { delete artistImgPending[k]; });
  }
  apply(await artistImgPending[k]);
}

// visão agrupada: carrosséis horizontais por GÊNERO, cada um com cards de ARTISTA
function renderGenreShelves(list, sorted) {
  const OTHERS = t('library.others');
  const genres = new Map(); // gênero -> { display, artists: Map(artistKey -> {display, songs[]}) }
  for (const s of sorted) {
    const gk = (s.genre || '').trim() || OTHERS;
    let g = genres.get(gk);
    if (!g) { g = { display: gk, artists: new Map() }; genres.set(gk, g); }
    const ak = artistKeyOf(s);
    let a = g.artists.get(ak);
    if (!a) { a = { display: s.artist || t('library.noArtist'), songs: [] }; g.artists.set(ak, a); }
    a.songs.push(s);
  }

  // gêneros: mais artistas primeiro; "Outros" por último
  const shelves = [...genres.values()].sort((x, y) => {
    if (x.display === OTHERS) return 1;
    if (y.display === OTHERS) return -1;
    return y.artists.size - x.artists.size || x.display.localeCompare(y.display, t('meta.locale'));
  });

  let gi = 0;
  for (const g of shelves) {
    const shelf = document.createElement('div');
    shelf.className = 'genre-shelf';
    shelf.style.setProperty('--i', String(Math.min(gi++, 6)));

    const head = document.createElement('div');
    head.className = 'genre-head';
    // (não usar "t" como nome aqui: sombrearia a função de tradução t())
    const gTitle = document.createElement('div'); gTitle.className = 'genre-title'; gTitle.textContent = g.display;
    const c = document.createElement('div'); c.className = 'genre-count';
    c.textContent = tn('count.artist', g.artists.size);
    head.append(gTitle, c);
    shelf.appendChild(head);

    const car = document.createElement('div');
    car.className = 'carousel';
    const artists = [...g.artists.values()].sort((a, b) => a.display.localeCompare(b.display, t('meta.locale')));
    let ai = 0;
    for (const a of artists) {
      const ac = buildArtistCard(a);
      ac.style.setProperty('--i', String(Math.min(ai++, 12)));
      car.appendChild(ac);
    }
    // roda vertical do mouse → rolagem horizontal do carrossel
    car.addEventListener('wheel', (e) => {
      if (!e.deltaY) return;
      const before = car.scrollLeft;
      car.scrollLeft += e.deltaY;
      if (car.scrollLeft !== before) e.preventDefault();
    }, { passive: false });

    shelf.appendChild(car);
    list.appendChild(shelf);
  }
}

function buildArtistCard(a) {
  const card = document.createElement('div');
  card.className = 'artist-card';

  const photo = document.createElement('div');
  photo.className = 'a-photo';
  const inner = document.createElement('div');
  inner.className = 'a-photo-inner';
  inner.textContent = artistInitials(a.display);
  const play = document.createElement('button');
  play.className = 'a-play';
  play.title = t('common.play');
  play.innerHTML = ICONS.play;
  play.addEventListener('click', (e) => {
    e.stopPropagation();
    spawnPlayBurst(card);
    playList(sortSongs(a.songs));
  });
  photo.append(inner, play);
  // foto + paleta: o halo do hover usa a cor dominante da foto do artista
  fillArtistAvatar(inner, a.display).then(async () => {
    const dataUrl = artistImgCache[normPart(a.display)];
    if (!dataUrl) return;
    const pal = await getPalette(dataUrl);
    if (pal) card.style.setProperty('--cv', `${pal.r}, ${pal.g}, ${pal.b}`);
  });

  const name = document.createElement('div');
  name.className = 'a-name';
  name.textContent = a.display;
  const sub = document.createElement('div');
  sub.className = 'a-sub';
  sub.textContent = tn('count.song', a.songs.length);

  card.append(photo, name, sub);
  card.addEventListener('click', () => openArtistPage(a));
  return card;
}

// ---- Página do artista (imersiva) ----
let artistPageSongs = [];
function openArtistPage(a) {
  const sorted = sortSongs(a.songs);
  artistPageSongs = sorted;
  $('apName').textContent = a.display;

  const albums = new Set(sorted.map((s) => normalizeText(s.album || '')).filter(Boolean));
  const nS = sorted.length, nA = albums.size;
  $('apStats').textContent = tn('count.song', nS) +
    (nA ? ` · ${tn('count.album', nA)}` : '');

  const photo = $('apPhoto');
  photo.innerHTML = `<span class="ap-initials">${artistInitials(a.display)}</span>`;
  $('artistPage').style.setProperty('--cv', '124, 92, 255'); // ambiente padrão

  renderArtistTracks($('apTracks'), sorted);
  $('artistPage').classList.remove('hidden', 'closing');
  $('apTracks').parentElement.scrollTop = 0; // rola para o topo

  // Limpa estado anterior das stats
  $('apLastfmInfo').classList.add('hidden');
  $('apListeners').textContent = '—';
  $('apPlaycount').textContent = '—';
  $('apGlobalTags').innerHTML = '';
  $('apTagsCard').classList.add('hidden');
  $('apBio').innerHTML = '';
  $('apBioCard').classList.add('hidden');

  // foto do artista + cor ambiente carregam em segundo plano
  fillArtistAvatar(photo, a.display).then(async () => {
    const dataUrl = artistImgCache[normPart(a.display)];
    if (dataUrl) {
      const pal = await getPalette(dataUrl);
      if (pal) $('artistPage').style.setProperty('--cv', `${pal.r}, ${pal.g}, ${pal.b}`);
    }
  });

  // Fetch Last.fm info (Bio, Stats, Tags)
  window.api.lastfmGetArtistInfo({ artist: a.display }).then(res => {
    if (res && window.getComputedStyle($('artistPage')).display !== 'none' && $('apName').textContent === a.display) {
      $('apLastfmInfo').classList.remove('hidden', 'closing');
      $('apListeners').textContent = res.listeners ? parseInt(res.listeners).toLocaleString(t('meta.numberLocale')) : '—';
      $('apPlaycount').textContent = res.playcount ? parseInt(res.playcount).toLocaleString(t('meta.numberLocale')) : '—';
      
      if (res.tags && res.tags.length > 0) {
        res.tags.forEach(tag => {
          const pill = document.createElement('span');
          pill.className = 'ev-tag';
          pill.textContent = tag;
          $('apGlobalTags').appendChild(pill);
        });
        $('apTagsCard').classList.remove('hidden', 'closing');
      }
      
      if (res.bio) {
        // Bio summary do Last.fm vem com links HTML muitas vezes.
        // Removendo ou formatando seria bom, mas podemos jogar o textContent puro (ou innerHTML confiavel)
        const bioHtml = res.bio.replace(/<a href="https:\/\/www\.last\.fm.*?>Read more on Last\.fm<\/a>/, '').trim();
        if (bioHtml.length > 10) {
          $('apBio').innerHTML = bioHtml;
          $('apBioCard').classList.remove('hidden', 'closing');
          $('apBio').onclick = () => $('apBio').classList.toggle('expanded');
        }
      }
    }
  });
}
function closeArtistPage() { closeViewAnimated($('artistPage')); }

function renderArtistTracks(container, sortedSongs) {
  container.innerHTML = '';
  const albums = new Map();
  for (const s of sortedSongs) {
    const ak = normalizeText(s.album || '') || '__none__';
    let al = albums.get(ak);
    if (!al) { al = { display: s.album || t('library.noAlbum'), year: s.year || '', songs: [] }; albums.set(ak, al); }
    al.songs.push(s);
  }
  for (const [, al] of albums) {
    if (al.display && al.display !== t('library.noAlbum')) {
      const ah = document.createElement('div');
      ah.className = 'group-album';
      const firstSong = al.songs[0];
      const th = document.createElement('div');
      th.className = 'group-album-thumb';
      if (!firstSong || coverState.get(firstSong.filePath) === false) {
        th.textContent = '♪';
      } else {
        const ai = document.createElement('img');
        ai.alt = ''; ai.loading = 'lazy';
        ai.onerror = () => { coverState.set(firstSong.filePath, false); th.textContent = '♪'; };
        ai.src = coverUrl(firstSong);
        th.appendChild(ai);
      }
      const name = document.createElement('span'); name.className = 'group-album-name'; name.textContent = al.display;
      const meta = document.createElement('span'); meta.className = 'group-album-meta';
      const n = al.songs.length;
      meta.textContent = (al.year ? `${al.year} · ` : '') + tn('count.track', n);
      ah.append(th, name, meta);
      container.appendChild(ah);
    }
    for (const s of al.songs) container.appendChild(buildSongCard(s, sortedSongs));
  }
}

$('apBack').addEventListener('click', closeArtistPage);
$('apPlay').addEventListener('click', () => playList(artistPageSongs));

// ====================== Playlists ======================
let playlists = [];
let currentPlaylistId = null;
let plDragFrom = -1;

async function loadPlaylists() {
  try { const cfg = await window.api.getConfig(); playlists = Array.isArray(cfg.playlists) ? cfg.playlists : []; }
  catch { playlists = []; }
}
async function savePlaylists() { try { await window.api.setConfig({ playlists }); } catch { /* ok */ } }
function findPlaylist(id) { return playlists.find((p) => p.id === id); }
function playlistSongs(p) {
  const byPath = new Map(songs.map((s) => [s.filePath, s]));
  return (p.tracks || []).map((fp) => byPath.get(fp)).filter(Boolean);
}
function playlistCoverHtml(pSongs) {
  const covers = [];
  const seenAlbums = new Set();
  for (const s of pSongs) {
    if (coverState.get(s.filePath) === false) continue;
    // dedupe por álbum (mesma capa) ou por arquivo quando sem álbum
    const k = normalizeText(s.album || '') || s.filePath;
    if (seenAlbums.has(k)) continue;
    seenAlbums.add(k);
    covers.push(coverUrl(s));
    if (covers.length >= 4) break;
  }
  if (!covers.length) return '<span class="pl-cover-ph">♪</span>';
  if (covers.length < 4) return `<span class="pl-cover-ph" style="background-image:url('${covers[0]}');background-size:cover;background-position:center"></span>`;
  return covers.map((c) => `<img src="${c}" alt="" />`).join('');
}

function createPlaylist(name) {
  const p = { id: 'pl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5), name: name || t('playlists.new'), tracks: [], createdAt: Date.now() };
  playlists.push(p);
  savePlaylists();
  return p;
}
function addToPlaylist(id, filePath) {
  const p = findPlaylist(id); if (!p) return;
  if (!p.tracks.includes(filePath)) { p.tracks.push(filePath); savePlaylists(); toast(t('playlists.addedTo', { name: p.name }), 'success'); }
  else toast(t('playlists.alreadyIn'), '');
}
function removeFromPlaylist(id, filePath) {
  const p = findPlaylist(id); if (!p) return;
  const i = p.tracks.indexOf(filePath);
  if (i >= 0) { p.tracks.splice(i, 1); savePlaylists(); if (currentPlaylistId === id) openPlaylistPage(id); }
}
function reorderPlaylist(id, from, to) {
  const p = findPlaylist(id); if (!p) return;
  const arr = p.tracks;
  if (from < 0 || from >= arr.length || to < 0 || to >= arr.length) return;
  const [m] = arr.splice(from, 1);
  arr.splice(to, 0, m);
  savePlaylists();
  openPlaylistPage(id);
}

// ---- Grade de playlists ----
function openPlaylistsView() {
  renderPlaylistsGrid();
  $('playlistsView').classList.remove('hidden', 'closing');
  $('playlistsView').querySelector('.ap-scroll').scrollTop = 0;
}
function closePlaylistsView() { closeViewAnimated($('playlistsView')); }
let _plIntentsWired = false;
function renderPlaylistsGrid() {
  const grid = $('plGrid');
  if (!_plIntentsWired) { // delegação: card Lit <syn-playlist-card> sobe syn:playlist:open
    grid.addEventListener('syn:playlist:open', (e) => openPlaylistPage(e.detail.id));
    _plIntentsWired = true;
  }
  grid.innerHTML = '';
  for (const p of playlists) {
    const ps = playlistSongs(p);
    const c = document.createElement('syn-playlist-card');
    c.pid = p.id; c.name = p.name; c.sub = tn('count.track', p.tracks.length); c.coverHtml = playlistCoverHtml(ps);
    grid.appendChild(c);
  }
  // card "Nova playlist"
  const add = document.createElement('div');
  add.className = 'pl-card pl-new';
  add.innerHTML = `<div class="pl-cover">${ICONS.plusSm}</div><div class="pl-card-name">${t('playlists.new')}</div><div class="pl-card-sub">${t('playlists.create')}</div>`;
  add.addEventListener('click', newPlaylistFlow);
  grid.appendChild(add);
  $('plEmpty').classList.toggle('hidden', playlists.length > 0);
}
function newPlaylistFlow() {
  const p = createPlaylist();
  openPlaylistPage(p.id);
  setTimeout(renamePlaylistInline, 80); // já abre pronto para nomear
}
$('playlistsBtn').addEventListener('click', openPlaylistsView);
$('plViewBack').addEventListener('click', closePlaylistsView);
$('plNewBtn').addEventListener('click', newPlaylistFlow);

// ---- Página da playlist ----
function openPlaylistPage(id) {
  const p = findPlaylist(id);
  if (!p) { closePlaylistPage(); return; }
  currentPlaylistId = id;
  const ps = playlistSongs(p);

  $('ppName').textContent = p.name;
  $('ppStats').textContent = tn('count.song', ps.length);
  $('ppCover').innerHTML = playlistCoverHtml(ps);

  // ambiente derivado da 1ª capa
  const firstCover = ps.find((s) => coverState.get(s.filePath) !== false);
  if (firstCover) {
    getPalette(coverUrl(firstCover)).then((pal) => {
      if (pal) $('playlistPage').style.setProperty('--cv', `${pal.r}, ${pal.g}, ${pal.b}`);
    });
  } else $('playlistPage').style.setProperty('--cv', '124, 92, 255');

  // faixas com reordenação + remover
  const box = $('ppTracks');
  box.innerHTML = '';
  ps.forEach((s, i) => box.appendChild(buildPlaylistRow(s, ps, i, id)));
  $('ppEmpty').classList.toggle('hidden', ps.length > 0);

  $('playlistPage').classList.remove('hidden', 'closing');
  $('playlistPage').querySelector('.ap-scroll').scrollTop = 0;
  markPlayingCards();
}
function closePlaylistPage() { closeViewAnimated($('playlistPage')); currentPlaylistId = null; }

function buildPlaylistRow(s, pSongs, index, id) {
  const card = buildSongCard(s, pSongs);
  card.classList.add('pp-row');
  card.draggable = true;

  // ilha Lit: handle + remover vêm no TEMPLATE (modo row) — não injetar no light-DOM
  // (o card re-renderiza ao carregar a capa e apagaria nós injetados).
  card.vm = { ...card.vm, row: true };
  card.addEventListener('syn:song:remove', () => removeFromPlaylist(id, s.filePath));

  card.addEventListener('dragstart', () => { plDragFrom = index; card.classList.add('dragging'); });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    document.querySelectorAll('.pp-row.drop-target').forEach((el) => el.classList.remove('drop-target'));
    plDragFrom = -1;
  });
  card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drop-target'); });
  card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
  card.addEventListener('drop', (e) => {
    e.preventDefault(); card.classList.remove('drop-target');
    if (plDragFrom < 0 || plDragFrom === index) return;
    reorderPlaylist(id, plDragFrom, index);
  });
  return card;
}

function renamePlaylistInline() {
  const p = findPlaylist(currentPlaylistId); if (!p) return;
  const nameEl = $('ppName');
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'pp-name-input'; input.value = p.name;
  nameEl.textContent = ''; nameEl.appendChild(input);
  input.focus(); input.select();
  const commit = async () => {
    const v = input.value.trim() || p.name;
    p.name = v; await savePlaylists();
    nameEl.textContent = v;
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    else if (e.key === 'Escape') { input.value = p.name; input.blur(); }
  });
  input.addEventListener('blur', commit, { once: true });
}

$('ppBack').addEventListener('click', () => { closePlaylistPage(); openPlaylistsView(); });
$('ppPlay').addEventListener('click', () => { const p = findPlaylist(currentPlaylistId); if (p) playList(playlistSongs(p)); });
$('ppRename').addEventListener('click', renamePlaylistInline);
$('ppDelete').addEventListener('click', async () => {
  const p = findPlaylist(currentPlaylistId); if (!p) return;
  if (!confirm(t('playlists.deleteConfirm', { name: p.name }))) return;
  playlists = playlists.filter((x) => x.id !== p.id);
  await savePlaylists();
  closePlaylistPage();
  openPlaylistsView();
  toast(t('playlists.deleted'), 'success');
});
$('ppExport').addEventListener('click', async () => {
  const p = findPlaylist(currentPlaylistId); if (!p || !p.tracks.length) { toast(t('playlists.empty'), 'error'); return; }
  const res = await window.api.playlistExportM3u({ name: p.name, tracks: p.tracks });
  if (res && res.error) { toast(res.error, 'error'); return; }
  if (res && res.success) toast(t('playlists.exported'), 'success');
});
$('ppSync').addEventListener('click', async () => {
  const p = findPlaylist(currentPlaylistId); if (!p || !p.tracks.length) { toast(t('playlists.empty'), 'error'); return; }
  if (!activeDevice) { toast(t('playlists.connectDevice'), 'error'); return; }
  showScanIndicator(t('playlists.syncing'));
  const res = await window.api.playlistSyncToDevice({ serial: activeDevice.serial, name: p.name, tracks: p.tracks });
  hideScanIndicator();
  if (res && res.error) { toast(res.error, 'error'); return; }
  try { const st = await window.api.deviceSyncState(activeDevice.serial); syncedKeys = new Set(st.keys || []); renderList(); } catch { /* ok */ }
  toast(t('playlists.syncResult', {
    count: res.count,
    copied: res.copied ? t('playlists.syncCopied', { n: res.copied }) : ''
  }), 'success');
});

// ---- "Adicionar à playlist" (menu de contexto) ----
function openAddToPlaylistMenu(s, anchorEl) {
  closeSongMenu();
  const menu = document.createElement('div');
  menu.id = 'songContext';
  menu.className = 'song-context';

  const head = document.createElement('div'); head.className = 'ctx-head'; head.textContent = t('playlists.addToMenu');
  menu.appendChild(head);
  for (const p of playlists) {
    const item = document.createElement('button');
    item.className = 'ctx-item';
    item.innerHTML = `${ICONS.queue}<span>${escapeHtmlText(p.name)}</span>`;
    item.addEventListener('click', (e) => { e.stopPropagation(); closeSongMenu(); addToPlaylist(p.id, s.filePath); });
    menu.appendChild(item);
  }
  const sep = document.createElement('div'); sep.className = 'ctx-sep'; menu.appendChild(sep);
  const nv = document.createElement('button');
  nv.className = 'ctx-item';
  nv.innerHTML = `${ICONS.plusSm}<span>${t('playlists.new')}</span>`;
  nv.addEventListener('click', (e) => {
    e.stopPropagation(); closeSongMenu();
    const p = createPlaylist(); p.tracks.push(s.filePath); savePlaylists();
    toast(t('playlists.createdWithTrack', { name: p.name }), 'success');
  });
  menu.appendChild(nv);

  document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  const mw = 200;
  let left = r.right - mw; if (left < 8) left = 8;
  let top = r.bottom + 4; if (top + 200 > window.innerHeight - 8) top = Math.max(8, r.top - 200);
  menu.style.left = left + 'px'; menu.style.top = top + 'px';
  songMenuDocHandler = (e) => { const m = document.getElementById('songContext'); if (m && !m.contains(e.target)) closeSongMenu(); };
  setTimeout(() => { document.addEventListener('click', songMenuDocHandler); window.addEventListener('resize', closeSongMenu); }, 0);
}

// View-model do card p/ a ilha Lit (renderer prepara; o componente é view pura).
function songVM(s) {
  const synced = hasSyncContext && syncedKeys.has(keyOf(s));
  return {
    path: s.filePath,
    title: s.title || s.fileName.replace(/\.mp3$/i, ''),
    sub: songSubtitle(s),
    src: coverUrl(s),
    coverKnown: coverState.get(s.filePath),
    deviceOnly: !!s.deviceOnly,
    badge: s.deviceOnly
      ? { kind: 'device', label: t('badges.onDevice'), title: t('badges.onDeviceTitle') }
      : (hasSyncContext ? { kind: 'sync', synced, label: synced ? t('badges.syncedTitle') : t('badges.notSyncedTitle') } : null),
  };
}
// Card Lit (light-DOM): mesma classe/data-path → CSS + querySelectors do renderer seguem.
// Os intents reusam a orquestração existente com o closure (s, queueList).
function buildSongCardLit(s, queueList) {
  const el = document.createElement('syn-song-card');
  el.vm = songVM(s);
  el.t = t;
  el.addEventListener('syn:song:play', () => {
    if (current && current.filePath === s.filePath) togglePlay();
    else { spawnPlayBurst(el); playFromCard(s, queueList); if (isDemoTrack(s)) revealDemoImmersive(); }
  });
  el.addEventListener('syn:song:menu', () => openSongMenu(s, el.querySelector('.song-menu')));
  el.addEventListener('syn:song:cover', (e) => { coverState.set(s.filePath, e.detail.ok); if (e.detail.ok) applyPalette(el, e.detail.src); });
  if (current && current.filePath === s.filePath) { el.classList.add('playing'); if (!isPlaying) el.classList.add('paused'); }
  return el;
}

// Card de faixa = ilha Lit <syn-song-card> (dirigida por VM; capa/badges/intents internos).
function buildSongCard(s, queueList) {
  return buildSongCardLit(s, queueList);
}

function buildPendingCard(job) {
  const card = document.createElement('div');
  card.className = 'song-card pending' + (job.status === 'error' ? ' error' : '');
  card.dataset.jobId = job.id;

  const thumb = document.createElement('div');
  thumb.className = 'song-thumb';
  if (job.coverDataUrl) {
    const img = document.createElement('img');
    img.src = job.coverDataUrl; img.alt = '';
    thumb.appendChild(img);
  } else {
    thumb.innerHTML = '<span class="ph">♪</span>';
  }

  const info = document.createElement('div');
  info.className = 'song-info';
  const title = document.createElement('div');
  title.className = 'song-title';
  title.textContent = job.title || t('jobs.newSong');
  const sub = document.createElement('div');
  sub.className = 'song-sub';
  sub.textContent = job.status === 'error' ? ('⚠ ' + (job.error || t('jobs.failed'))) : (job.statusMsg || t('jobs.queued'));
  info.append(title, sub);

  if (job.status !== 'error') {
    const prog = document.createElement('div');
    prog.className = 'progress';
    const bar = document.createElement('div');
    bar.className = 'progress-bar';
    bar.style.width = (job.progress || 0) + '%';
    prog.appendChild(bar);
    info.appendChild(prog);
  }

  card.append(thumb, info);

  if (job.status === 'error') {
    // tentar novamente: o job volta para a fila de download
    const retry = document.createElement('button');
    retry.className = 'song-menu';
    retry.textContent = '↻';
    retry.title = t('jobs.retry');
    retry.addEventListener('click', () => {
      job.status = 'queued';
      job.error = null;
      job.progress = 0;
      job.statusMsg = t('jobs.queued');
      renderList();
      pumpDownloads();
    });
    // descartar o job com erro
    const dismiss = document.createElement('button');
    dismiss.className = 'song-menu';
    dismiss.textContent = '✕';
    dismiss.title = t('jobs.dismiss');
    dismiss.addEventListener('click', () => {
      pendingJobs = pendingJobs.filter((j) => j !== job);
      renderList();
    });
    card.append(retry, dismiss);
  }
  return card;
}

// atualização leve só da barra/texto de um job (evita re-render completo a cada tick)
function updateJobEl(job) {
  const el = document.querySelector(`.song-card.pending[data-job-id="${job.id}"]`);
  if (!el) { renderList(); return; }
  const bar = el.querySelector('.progress-bar');
  if (bar) bar.style.width = (job.progress || 0) + '%';
  const sub = el.querySelector('.song-sub');
  if (sub) sub.textContent = job.statusMsg || t('jobs.processing');
  const title = el.querySelector('.song-title');
  if (title && job.title) title.textContent = job.title;
  if (job.coverDataUrl) {
    const thumb = el.querySelector('.song-thumb');
    if (thumb && !thumb.querySelector('img')) {
      thumb.innerHTML = `<img src="${job.coverDataUrl}" alt="" />`;
    }
  }
  refreshToolbarStatus(); // resumo de loading sempre visível na barra superior
}

// ====================== Adicionar (overlay: URL do YouTube ou arquivo MP3) ======================
function openAdd() {
  collapseSearch();                       // o adicionar sobrepõe a busca
  $('addBar').classList.add('open');
  $('addError').classList.add('hidden');
  setTimeout(() => $('ytUrl').focus(), 40);
}
function closeAdd() {
  $('addBar').classList.remove('open');
  $('addError').classList.add('hidden');
}
$('addBtn').addEventListener('click', () => {
  if ($('addBar').classList.contains('open')) closeAdd();
  else openAdd();
});
$('addCancel').addEventListener('click', () => { $('ytUrl').value = ''; closeAdd(); });

function isYouTubeUrl(url) {
  return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\//i.test(url || '');
}

function enqueueAdd() {
  const url = $('ytUrl').value.trim();
  const errEl = $('addError');
  if (!url) return;
  if (!isYouTubeUrl(url)) {
    errEl.textContent = t('main.invalidUrl');
    errEl.classList.remove('hidden', 'closing');
    return;
  }
  $('ytUrl').value = '';
  closeAdd();

  pendingJobs.push({
    id: 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    url, status: 'queued', progress: 0, statusMsg: t('jobs.queued'),
    title: '', artist: '', year: '', coverDataUrl: null, error: null
  });
  renderList();
  pumpDownloads();
}

// importar um MP3 local para a biblioteca
async function importMp3() {
  const p = await window.api.selectMp3();
  if (!p) return;
  $('ytUrl').value = '';
  closeAdd();
  showScanIndicator(t('jobs.importing'));
  const res = await window.api.libraryImport(p);
  if (res.error) { hideScanIndicator(); toast(res.error, 'error'); return; }
  // etapa de enriquecimento: busca a letra (sincronizada, se houver) e grava no arquivo
  showScanIndicator(t('jobs.fetchingLyrics'));
  try { await window.api.enrichLyricsFile(res.filePath); } catch { /* sem letra: segue */ }
  hideScanIndicator();
  await reloadLibrary();
  maybeResync();
  toast(t('jobs.mp3Added'), 'success');
}

$('ytBtn').addEventListener('click', enqueueAdd);
$('pickMp3').addEventListener('click', importMp3);
$('ytUrl').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') enqueueAdd();
  else if (e.key === 'Escape') { $('ytUrl').value = ''; closeAdd(); }
});

// Motor de fila: no máximo 2 downloads simultâneos. Ao terminar o download, o job
// passa para o enriquecimento (que é serializado/espaçado pelo rate limiter no main,
// na ordem em que os downloads terminam) e uma vaga de download é liberada.
const MAX_DOWNLOADS = 2;

function pumpDownloads() {
  const downloading = pendingJobs.filter((j) => j.status === 'downloading').length;
  let slots = MAX_DOWNLOADS - downloading;
  for (const job of pendingJobs) {
    if (slots <= 0) break;
    if (job.status === 'queued') {
      slots--;
      startJob(job); // marca como 'downloading' de forma síncrona
    }
  }
}

async function startJob(job) {
  job.status = 'downloading';
  job.progress = 2;
  job.statusMsg = t('jobs.starting');
  updateJobEl(job);

  try {
    // 1) baixar áudio + coletar contexto da página
    const dl = await window.api.youtubeDownload({ jobId: job.id, url: job.url });
    if (dl.error) throw new Error(dl.error);
    job.tempPath = dl.filePath;
    job.ytContext = dl.ytContext;
    job.thumb = dl.thumbnailDataUrl;
    job.title = dl.videoTitle || t('jobs.newSong');

    // download concluído -> entra no enriquecimento e libera vaga para o próximo
    job.status = 'enriching';
    job.progress = 60;
    job.statusMsg = t('jobs.enrichQueue');
    updateJobEl(job);
    pumpDownloads();

    // 2) enriquecer metadados (fontes factuais + 2 chamadas, rate-limited no main)
    let data = {};
    let factualCover = null;
    if (dl.ytContext) {
      const meta = await window.api.smartMetadata({
        jobId: job.id,
        ytContext: dl.ytContext,
        hint: '',
        raw: { fileName: dl.videoTitle, title: '', artist: '', album: '' }
      });
      if (meta.error) throw new Error(meta.error);
      data = meta.data || {};
      factualCover = meta.coverDataUrl || null; // capa em alta de MusicBrainz/iTunes
    }

    // 3) capa: prioriza a capa factual em alta sobre a thumbnail do YouTube
    let coverDataUrl = null;
    const coverSource = factualCover || dl.thumbnailDataUrl;
    if (coverSource) {
      try { coverDataUrl = await makeCenterCrop(coverSource); }
      catch { coverDataUrl = coverSource; }
    }
    job.title = data.title || dl.videoTitle;
    job.artist = data.artist || '';
    job.year = data.year || '';
    job.coverDataUrl = coverDataUrl;
    updateJobEl(job);

    // 3.5) letra: busca sincronizada (LRCLIB) como etapa de enriquecimento
    if (data.title || data.artist || dl.videoTitle) {
      job.statusMsg = t('jobs.fetchingLyrics');
      job.progress = 90;
      updateJobEl(job);
      try {
        const ly = await window.api.fetchSyncedLyrics({
          artist: data.artist || '',
          title: data.title || dl.cleanName || dl.videoTitle || '',
          album: data.album || '',
          duration: 0
        });
        if (ly && !ly.error && (ly.synced || ly.plain)) data.lyrics = ly.synced || ly.plain;
      } catch { /* sem letra: segue sem bloquear o salvamento */ }
    }

    // 4) salvar direto na biblioteca (sem diálogo)
    job.status = 'saving';
    job.progress = 94;
    job.statusMsg = t('jobs.savingLibrary');
    updateJobEl(job);
    const suggested = (data.artist && data.title)
      ? `${data.artist} - ${data.title}`
      : (data.title || dl.cleanName || dl.videoTitle || 'audio');
    const save = await window.api.saveTags({
      filePath: dl.filePath,
      source: 'library',
      suggestedName: suggested,
      imageDataUrl: coverDataUrl,
      fields: data
    });
    if (save.error) throw new Error(save.error);

    // concluído: remove o job e recarrega a biblioteca
    const title = job.title;
    pendingJobs = pendingJobs.filter((j) => j !== job);
    await reloadLibrary();
    toast(t('jobs.added', { title }), 'success');
    maybeResync(); // se há dispositivo sincronizando, leva a nova música
  } catch (err) {
    job.status = 'error';
    job.error = (err && err.message) ? err.message : String(err);
    renderList();
  } finally {
    // garante que a fila continue (caso a falha tenha ocorrido ainda no download)
    pumpDownloads();
  }
}

// progresso do download (yt-dlp), por jobId -> mapeia para 2–58%
window.api.onYoutubeProgress(({ jobId, msg, percent }) => {
  const job = pendingJobs.find((j) => j.id === jobId);
  if (!job || job.status !== 'downloading') return;
  if (percent != null && percent > 0) job.progress = 2 + Math.round((percent / 100) * 56);
  job.statusMsg = (percent != null && percent > 0) ? t('jobs.downloadingPct', { p: percent }) : (msg || t('jobs.downloading'));
  updateJobEl(job);
});

// progresso do pipeline Gemini, por jobId -> 60–92%
// usa as flags estruturadas do payload (waiting/step), independentes do idioma
window.api.onGeminiProgress(({ jobId, msg, waiting, step }) => {
  const job = pendingJobs.find((j) => j.id === jobId);
  if (!job) return;
  job.statusMsg = msg;
  if (waiting) {
    // em espera de rate limit: mantém a barra, só atualiza o texto
  } else if (step === 1) {
    job.progress = 68;
  } else if (step === 2) {
    job.progress = 84;
  }
  updateJobEl(job);
});

// ====================== Editor (modal) ======================
function showEditor() { $('editorBackdrop').classList.remove('hidden', 'closing'); }
function hideEditor() { closeViewAnimated($('editorBackdrop')); }

async function openEditor(song) {
  // faixa que só existe no dispositivo: traz a cópia para o PC antes de editar
  if (song.deviceOnly) {
    showLoading(t('editor.fetchingDevice'));
    await paint();
    const res = await window.api.deviceEnrichFromDevice({ serial: song.serial, filePath: song.filePath });
    hideLoading();
    if (res.error) { toast(res.error, 'error'); return; }
    deviceOnlySongs = deviceOnlySongs.filter((s) => s.filePath !== song.filePath);
    await reloadLibrary();
    song = { ...song, filePath: res.filePath, deviceOnly: false };
  }

  currentFilePath = song.filePath;
  currentEditorSong = song;
  currentYtContext = null;
  showLoading(t('editor.readingMeta'));
  await paint();
  try {
    const tags = await window.api.readTags(song.filePath);
    if (tags.error) { toast(tags.error, 'error'); return; }

    $('fileName').textContent = tags.fileName;
    fields.forEach((f) => { if ($(f)) $(f).value = tags[f] || ''; });
    $('hint').value = '';
    $('aiStatus').classList.add('hidden');
    // Atualiza o status card de letra (lê tag LRCLIB_SYNC do arquivo)
    updateLyricsStatusCard();

    resetCover();
    if (song.coverDataUrl) {
      // fluxo do YouTube: a capa recém-baixada chega como data URL transiente
      await setCoverFromSource(song.coverDataUrl);
    } else if (tags.hasCover) {
      // arquivo da biblioteca: busca a capa como data URL editável (one-off)
      const fetched = await window.api.getCover(song.filePath);
      if (fetched) await setCoverFromSource(fetched);
      else $('coverPreview').innerHTML = `<span class="cover-placeholder">${t('editor.embeddedCoverPh')}</span>`;
    }
    // abre na VISUALIZAÇÃO (somente leitura); o lápis alterna para edição
    $('editor').classList.remove('edit-mode');
    $('editor').classList.add('view-mode');
    renderEditorView();
    showEditor();
  } catch (err) {
    toast(t('editor.openFail', { msg: (err && err.message ? err.message : err) }), 'error');
  } finally {
    hideLoading();
  }
}

// monta a visualização de detalhes (somente leitura) a partir dos campos atuais
function renderEditorView() {
  const get = (id) => ($(id) ? $(id).value.trim() : '');
  const fname = ($('fileName').textContent || '').replace(/\.mp3$/i, '');
  $('evTitle').textContent = get('title') || fname || '—';
  $('evArtist').textContent = get('artist');
  $('evAlbum').textContent = [get('album'), get('year')].filter(Boolean).join(' · ');

  const coverSrc = currentImageDataUrl || coverSourceDataUrl ||
    (currentEditorSong && currentEditorSong.coverDataUrl) || null;
  $('evCover').innerHTML = coverSrc ? `<img src="${coverSrc}" alt="" />` : '<span class="ph">♪</span>';
  applyEditorColor(coverSrc);

  // Carrega e exibe estatísticas do Last.fm (Execuções, Cult/Hit, Tags)
  $('evLastfmStats').classList.add('hidden');
  $('evGlobalPlays').textContent = '—';
  $('evGlobalType').textContent = '—';
  $('evGlobalTags').innerHTML = '';
  $('evTagsCard').classList.add('hidden');
  $('evTypeIcon').textContent = '🔥';
  $('evTypeCard').className = 'ev-stat-card';

  const art = get('artist');
  const tit = get('title') || fname;
  const targetPath = currentEditorSong ? currentEditorSong.filePath : null;

  if (art && tit) {
    fetchGlobalPlaycount(art, tit).then((res) => {
      // Garante que o usuário ainda está vendo a mesma música
      if (!currentEditorSong || currentEditorSong.filePath !== targetPath) return;

      if (res && res.playcount) {
        const pc = parseInt(res.playcount, 10);
        const ls = parseInt(res.listeners, 10);

        $('evGlobalPlays').textContent = formatPlaycount(res.playcount);

        if (pc > 0 && ls > 0) {
          const ratio = pc / ls;
          if (ratio >= 6.5) {
            $('evGlobalType').textContent = t('stats.cult');
            $('evTypeIcon').textContent = '💎';
            $('evTypeCard').className = 'ev-stat-card cult';
            $('evTypeCard').title = t('stats.cultTitle', { ratio: ratio.toFixed(1) });
          } else {
            $('evGlobalType').textContent = t('stats.hit');
            $('evTypeIcon').textContent = '🔥';
            $('evTypeCard').className = 'ev-stat-card hit';
            $('evTypeCard').title = t('stats.hitTitle', { ratio: ratio.toFixed(1) });
          }
        } else {
          $('evGlobalType').textContent = t('stats.standard');
          $('evTypeIcon').textContent = '🎵';
          $('evTypeCard').className = 'ev-stat-card';
        }

        // Renderiza as pílulas de tags
        if (res.tags && res.tags.length > 0) {
          res.tags.forEach((tag) => {
            const pill = document.createElement('span');
            pill.className = 'ev-tag';
            pill.textContent = tag;
            $('evGlobalTags').appendChild(pill);
          });
          $('evTagsCard').classList.remove('hidden', 'closing');
        } else {
          $('evTagsCard').classList.add('hidden');
        }

        $('evLastfmStats').classList.remove('hidden', 'closing');
      }
    });
  }

  const items = [
    [t('fields.genre'), get('genre')],
    [t('fields.albumArtist'), get('albumArtist')],
    [t('fields.composer'), get('composer')],
    [t('fields.trackNumber'), get('trackNumber')],
    [t('fields.partOfSet'), get('partOfSet')],
    [t('fields.publisher'), get('publisher')],
    [t('fields.comment'), get('comment'), true]
  ].filter(([, v]) => v);

  const box = $('evMeta');
  box.innerHTML = '';
  for (const [label, value, full] of items) {
    const item = document.createElement('div');
    item.className = 'ev-meta-item' + (full ? ' full' : '');
    const l = document.createElement('div'); l.className = 'ev-meta-label'; l.textContent = label;
    const val = document.createElement('div'); val.className = 'ev-meta-value'; val.textContent = value;
    item.append(l, val);
    box.appendChild(item);
  }

  const liteEditor = !!customElements.get('syn-track-editor');
  const lyrics = get('lyrics');
  const lyricsVisible = !!lyrics;
  // Redesign (ilha): o painel de letra é o CARRO-CHEFE → sempre visível (vazio convida a buscar).
  // Legado: só aparece quando há letra.
  $('evLyricsWrap').classList.toggle('hidden', !liteEditor && !lyricsVisible);
  // na visualização, mostra a letra sem os timestamps do LRC
  $('evLyrics').textContent = isSyncedLyrics(lyrics) ? lrcToPlain(lyrics) : lyrics;
  if (liteEditor) updateLyricsStatusCard();   // atualiza o CTA de letra (lscTitle/lscSub/status)

  // Badge de status de sincronização na view mode
  if (currentFilePath) {
    window.api.lyricsGetSyncStatus(currentFilePath).then((r) => {
      const badge = $('evLyricsBadge');
      if (!badge) return;
      const syncTag = r && r.status ? r.status : null;
      const statusKey = computeLyricsStatus(syncTag, lyricsVisible);
      const st = LYRICS_STATUS[statusKey] || LYRICS_STATUS.empty;
      badge.className = 'ev-lyrics-badge ' + st.badgeCls;
      badge.textContent = t(st.badgeKey);
      // Mostra o badge apenas quando há letra e o estado é relevante
      badge.classList.toggle('hidden', !lyricsVisible || statusKey === 'empty');
    }).catch(() => {});
  } else {
    const badge = $('evLyricsBadge');
    if (badge) badge.classList.add('hidden');
  }
}

// tinge o ambiente do editor com a cor da capa
async function applyEditorColor(coverSrc) {
  const pal = coverSrc ? await getPalette(coverSrc) : null;
  $('editor').style.setProperty('--cv', pal ? `${pal.r}, ${pal.g}, ${pal.b}` : '124, 92, 255');
}

// Editor: roteador de cliques por DELEGAÇÃO no backdrop (nó estável). Cobre tanto o markup
// legado quanto a ilha <syn-track-editor> (que substitui o interior de #editor) — sobrevive
// à troca de DOM sem precisar re-ligar listeners. Botões identificados por id via closest().
$('editorBackdrop').addEventListener('click', (e) => {
  if (e.target === $('editorBackdrop')) { hideEditor(); return; }
  const hit = (id) => e.target.closest('#' + id);
  if (hit('editorBack'))      { hideEditor(); return; }
  if (hit('editToggle'))      { $('editor').classList.remove('view-mode'); $('editor').classList.add('edit-mode'); return; }
  if (hit('editDone'))        { saveDetails(); return; }
  if (hit('evPlay'))          { if (currentEditorSong) playFromCard(currentEditorSong); return; }
  if (hit('removeImageBtn'))  { resetCover(); return; }
  if (hit('adjustCoverBtn'))  { if (coverSourceDataUrl) openCropper(); return; }
  if (hit('selectImageBtn'))  { onSelectImageClick(); return; }
  if (hit('fetchBtn'))        { onFetchClick(); return; }
  if (hit('lyricsStatusBtn')) { if (currentFilePath) openLyricsModal(); return; }
  if (hit('deleteBtn'))       { onDeleteClick(); return; }
});

function resetCover() {
  currentImagePath = null;
  currentImageDataUrl = null;
  coverSourceDataUrl = null;
  $('coverPreview').innerHTML = `<span class="cover-placeholder">${t('editor.noCoverPh')}</span>`;
  $('removeImageBtn').classList.add('hidden');
  $('adjustCoverBtn').classList.add('hidden');
}

function showCoverPreview(dataUrl) {
  $('coverPreview').innerHTML = `<img src="${dataUrl}" alt="capa" />`;
  $('removeImageBtn').classList.remove('hidden', 'closing');
  $('adjustCoverBtn').classList.remove('hidden', 'closing');
}

async function setCoverFromSource(srcDataUrl) {
  coverSourceDataUrl = srcDataUrl;
  currentImagePath = null;
  try {
    currentImageDataUrl = await makeCenterCrop(srcDataUrl);
  } catch {
    currentImageDataUrl = srcDataUrl;
  }
  showCoverPreview(currentImageDataUrl);
}

// Cliques delegados pelo roteador do #editorBackdrop (selecionar/ajustar/remover capa).
async function onSelectImageClick() {
  const p = await window.api.selectImage();
  if (!p) return;
  const dataUrl = await window.api.imagePreview(p);
  if (!dataUrl) { toast(t('editor.imageReadFail'), 'error'); return; }
  await setCoverFromSource(dataUrl);
  openCropper();
}

// colar imagem do clipboard (Ctrl+V com a capa em foco)
function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
document.addEventListener('paste', async (e) => {
  if (document.activeElement !== $('coverPreview')) return;
  if (!currentFilePath) return;
  const items = (e.clipboardData && e.clipboardData.items) || [];
  let imageItem = null;
  for (const it of items) {
    if (it.kind === 'file' && it.type.startsWith('image/')) { imageItem = it; break; }
  }
  if (!imageItem) { toast(t('editor.pasteNoImage'), 'error'); return; }
  e.preventDefault();
  const blob = imageItem.getAsFile();
  if (!blob) return;
  try {
    const dataUrl = await readBlobAsDataUrl(blob);
    await setCoverFromSource(dataUrl);
    openCropper();
  } catch {
    toast(t('editor.pasteReadFail'), 'error');
  }
});

// Buscar metadados: fontes factuais (MusicBrainz/iTunes) → Gemini lacunas → consistência
async function onFetchClick() {
  if (!currentFilePath) return;
  const status = $('aiStatus');
  status.className = 'ai-status';
  status.textContent = t('editor.aiQuerying');
  status.classList.remove('hidden', 'closing');
  $('fetchBtn').disabled = true;

  const res = await window.api.smartMetadata({
    ytContext: currentYtContext || null,
    hint: $('hint').value,
    raw: {
      fileName: $('fileName').textContent,
      title: $('title').value, artist: $('artist').value, album: $('album').value
    }
  });
  $('fetchBtn').disabled = false;

  if (res.error) {
    status.className = 'ai-status error';
    status.textContent = '⚠ ' + res.error;
    return;
  }
  const d = res.data || {};
  let filled = 0;
  for (const f of fields) {
    if (d[f] && $(f)) { $(f).value = d[f]; filled++; }
  }
  // capa factual em alta (quando houver match confiável)
  if (res.coverDataUrl) { try { await setCoverFromSource(res.coverDataUrl); } catch { /* mantém capa */ } }

  const src = (res.sources && res.sources.length) ? t('editor.aiSources', { list: res.sources.join(', ') }) : '';
  status.className = 'ai-status';
  status.textContent = t('editor.aiResult', {
    filled,
    cover: res.coverDataUrl ? t('editor.aiCover') : '',
    sources: src
  });
}

// ==================== EDITOR IMERSIVO DE LETRAS ====================

// ---- Status map: 5 estados claros ----

// ---- Calcula o status composto (tag ID3 + presença de letra) ----
// Tabela de decisão:
//   sem letra + sem tag         → empty      (nunca tocou no fluxo)
//   sem letra + not_found       → not_found  (buscou, não achou)
//   sem letra + synced/local    → empty      (letra foi removida manualmente)
//   tem letra + sem tag         → pending    (origem desconhecida)
//   tem letra + local           → local      (criou/editou localmente)
//   tem letra + not_found       → local      (criou após busca falhar)
//   tem letra + synced          → synced     (veio do LRCLIB, intocada)
function computeLyricsStatus(syncTag, hasLyrics) {
  if (!hasLyrics) {
    if (syncTag === 'not_found') return 'not_found';
    return 'empty';
  }
  // tem letra:
  if (syncTag === 'synced')                        return 'synced';
  if (syncTag === 'local' || syncTag === 'not_found') return 'local';
  return 'pending'; // tag ausente
}

// ---- Atualiza o status card no formulário de edição ----
async function updateLyricsStatusCard() {
  const lyricsVal = ($('lyrics') && $('lyrics').value.trim()) || '';
  const hasLyrics = !!lyricsVal;
  let syncTag = null;
  if (currentFilePath) {
    try {
      const r = await window.api.lyricsGetSyncStatus(currentFilePath);
      syncTag = r && r.status ? r.status : null;
    } catch { /* sem tag */ }
  }
  const statusKey = computeLyricsStatus(syncTag, hasLyrics);
  const st = LYRICS_STATUS[statusKey] || LYRICS_STATUS.empty;

  // lscTitle = nome do status
  const titleEl = $('lscTitle');
  if (titleEl) titleEl.textContent = t(st.titleKey);

  // lscSub: se tem letra, mostra preview da primeira linha; senão, instrução do status
  const subEl = $('lscSub');
  if (subEl) {
    if (hasLyrics && statusKey !== 'empty') {
      const firstLine = lyricsVal.replace(/^\[.*?\]/gm, '').split('\n').find((l) => l.trim());
      subEl.textContent = firstLine
        ? (firstLine.length > 52 ? firstLine.slice(0, 49) + '…' : firstLine)
        : t(st.subKey);
    } else {
      subEl.textContent = t(st.subKey);
    }
  }

  // data-status-key ativa os seletores CSS do dot colorido
  const btn = $('lyricsStatusBtn');
  if (btn) {
    btn.dataset.statusKey = statusKey;
    btn.dataset.syncTag = syncTag || '';
  }
}

// ---- Abre o modal de opções de letra ----
function openLyricsModal() {
  const modal = $('lyricsModal');
  if (!modal) return;
  const lyricsVal = ($('lyrics') && $('lyrics').value.trim()) || '';
  const hasLyrics = !!lyricsVal;
  const statusKey = ($('lyricsStatusBtn') && $('lyricsStatusBtn').dataset.statusKey) || 'empty';
  const st = LYRICS_STATUS[statusKey] || LYRICS_STATUS.empty;

  // Título do modal = nome da música (ou fallback)
  const songTitle = $('title') && $('title').value.trim();
  $('lmTitle').textContent = songTitle || t('lyrics.modal.title');

  // Status dot + texto descritivo
  const dot = $('lmStatusDot');
  if (dot) dot.className = 'lm-status-dot ' + st.dotCls;
  const stTxt = $('lmStatusText');
  if (stTxt) stTxt.textContent = t(st.subKey);

  // ---- Visibilidade e texto contextual de cada ação ----

  // Botão Buscar: sempre visível, mas texto muda
  const searchBtn = $('lmSearchBtn');
  const searchLabel = $('lmSearchLabel');
  const searchSub = searchBtn && searchBtn.querySelector('.lm-action-sub');
  if (searchLabel) {
    if (statusKey === 'synced') {
      searchLabel.textContent = t('lyrics.modal.searchAgain');
      if (searchSub) searchSub.textContent = t('lyrics.modal.searchSubSynced');
    } else if (statusKey === 'not_found') {
      searchLabel.textContent = t('lyrics.modal.searchAgain');
      if (searchSub) searchSub.textContent = t('lyrics.modal.searchSubNotFound');
    } else if (hasLyrics) {
      searchLabel.textContent = t('lyrics.modal.search');
      if (searchSub) searchSub.textContent = t('lyrics.modal.searchSubReplace');
    } else {
      searchLabel.textContent = t('lyrics.modal.search');
      if (searchSub) searchSub.textContent = t('lyrics.modal.searchSub');
    }
  }

  // Botão Editar: sempre visível, texto contextual
  const editBtn = $('lmEditBtn');
  const editLabel = editBtn && editBtn.querySelector('strong');
  const editSub = editBtn && editBtn.querySelector('.lm-action-sub');
  if (editLabel) {
    if (!hasLyrics) {
      editLabel.textContent = t('lyrics.modal.create');
      if (editSub) editSub.textContent = t('lyrics.modal.createSub');
    } else if (statusKey === 'synced') {
      editLabel.textContent = t('lyrics.modal.edit');
      if (editSub) editSub.textContent = t('lyrics.modal.editSubSynced');
    } else {
      editLabel.textContent = t('lyrics.modal.edit');
      if (editSub) editSub.textContent = t('lyrics.modal.editSub');
    }
  }

  // Botão Publicar: só visível se TEM letra E não está synced
  const publishBtn = $('lmPublishBtn');
  if (publishBtn) {
    const canPublish = hasLyrics && statusKey !== 'synced';
    publishBtn.classList.toggle('hidden', !canPublish);
    const publishLabel = publishBtn.querySelector('strong');
    const publishSub = publishBtn.querySelector('.lm-action-sub');
    if (publishLabel) publishLabel.textContent = t('lyrics.modal.publish');
    if (publishSub) {
      if (statusKey === 'pending') {
        publishSub.textContent = t('lyrics.modal.publishSubPending');
      } else {
        publishSub.textContent = t('lyrics.modal.publishSub');
      }
    }
  }

  // Botão Remover: só visível se TEM letra
  const clearBtn = $('lmClearBtn');
  if (clearBtn) clearBtn.classList.toggle('hidden', !hasLyrics);

  modal.classList.remove('hidden');
  requestAnimationFrame(() => { const f = $('lmSearchBtn'); if (f) f.focus(); });
}

function closeLyricsModal() {
  const modal = $('lyricsModal');
  if (modal) modal.classList.add('hidden');
}

// ---- Event listeners do lyricsModal ----
// (o botão #lyricsStatusBtn é tratado pelo roteador delegado do #editorBackdrop)
$('lmCloseBtn').addEventListener('click', closeLyricsModal);
// Fechar ao clicar fora do painel (no overlay = backdrop)
$('lyricsModal').addEventListener('click', (e) => {
  if (e.target === $('lyricsModal')) closeLyricsModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('lyricsModal').classList.contains('hidden')) {
    closeLyricsModal();
  }
});

// -- Buscar na comunidade --
$('lmSearchBtn').addEventListener('click', async () => {
  const btn = $('lmSearchBtn');
  btn.classList.add('lm-loading');
  const dur = (current && current.filePath === currentFilePath && audio.duration) ? audio.duration : 0;
  const res = await window.api.fetchSyncedLyrics({
    artist: $('artist').value.trim(), title: $('title').value.trim(),
    album: $('album').value.trim(), duration: dur
  });
  btn.classList.remove('lm-loading');

  if (res.error) { toast(res.error, 'error'); return; }

  if (res.synced || res.plain) {
    $('lyrics').value = res.synced || res.plain;
    // ✅ Encontrado no LRCLIB → sincronia imediata
    if (currentFilePath) await window.api.lyricsSetSyncStatus(currentFilePath, 'synced');
    await updateLyricsStatusCard();
    toast(t('lyrics.toast.synced'), 'success');
    closeLyricsModal();
    // Salva no MP3 com tag synced
    saveDetailsWithSync('synced');
  } else {
    // Não encontrado → marca e mantém modal aberto com estado atualizado
    if (currentFilePath) await window.api.lyricsSetSyncStatus(currentFilePath, 'not_found');
    await updateLyricsStatusCard();
    toast(t('lyrics.toast.notFoundCreate'), '');
    // Reabre o modal com o estado atualizado (not_found)
    openLyricsModal();
  }
});

// -- Editar / Criar --
$('lmEditBtn').addEventListener('click', () => {
  closeLyricsModal();
  openLyricsEditor();
});

// -- Publicar no LRCLIB --
$('lmPublishBtn').addEventListener('click', async () => {
  const btn = $('lmPublishBtn');
  btn.classList.add('lm-loading');

  const syncedLyrics = $('lyrics').value.trim();
  const plainLyrics = lrcToPlain(syncedLyrics) || syncedLyrics;
  const dur = (current && current.filePath === currentFilePath && audio.duration) ? audio.duration : 0;

  if (!dur) {
    btn.classList.remove('lm-loading');
    toast(t('lyrics.toast.playFirst'), 'error');
    return;
  }

  const pubRes = await window.api.lyricsPublish({
    trackName: $('title').value.trim(),
    artistName: $('artist').value.trim(),
    albumName: $('album').value.trim(),
    duration: dur,
    plainLyrics,
    syncedLyrics,
    filePath: currentFilePath
  });

  btn.classList.remove('lm-loading');

  if (pubRes.error) {
    toast(t('lyrics.toast.publishError', { msg: pubRes.error }), 'error');
  } else {
    await updateLyricsStatusCard();
    toast(t('lyrics.toast.published'), 'success');
    closeLyricsModal();
    // Salva automaticamente a tag 'synced' no MP3
    saveDetailsWithSync('synced');
  }
});

// -- Remover letra --
$('lmClearBtn').addEventListener('click', async () => {
  if (!confirm(t('lyrics.confirm.remove'))) return;
  $('lyrics').value = '';
  if (currentFilePath) await window.api.lyricsSetSyncStatus(currentFilePath, 'not_found');
  await updateLyricsStatusCard();
  toast(t('lyrics.toast.removed'), '');
  closeLyricsModal();
  saveDetailsWithSync('not_found');
});

// ---- Editor de letra = ilha Lit <syn-lyrics-editor> ----
// Modal próprio montado no body (fora do app-root → recebe o player por propriedade); o
// renderer só lhe entrega os dados na abertura e PERSISTE no save (grava tags + status + reload).
let _litLyricsEditor = null;
let _leLitPlayerWasHidden = false;
function ensureLitLyricsEditor() {
  if (_litLyricsEditor) return _litLyricsEditor;
  const el = document.createElement('syn-lyrics-editor');
  el.classList.add('hidden');
  el.t = t; el.player = _litPlayer;
  el.addEventListener('syn:lyrics-editor:save', (e) => onLitLyricsEditorSave(e.detail));
  el.addEventListener('syn:lyrics-editor:close', () => onLitLyricsEditorClose());
  document.body.appendChild(el);
  _litLyricsEditor = el;
  return el;
}
function openLyricsEditorLit() {
  const el = ensureLitLyricsEditor();
  el.player = _litPlayer; el.t = t;
  el.open({
    title: $('title').value, artist: $('artist').value,
    lyrics: $('lyrics').value.trim(), chords: $('chords').value.trim(),
  });
  // garante a faixa em edição tocando (igual ao legado)
  if (currentEditorSong) {
    const alreadyPlaying = current && current.filePath === currentEditorSong.filePath;
    if (!alreadyPlaying) playFromCard(currentEditorSong);
  }
  // eleva o player acima do modal
  const playerEl = $('player');
  if (playerEl) {
    _leLitPlayerWasHidden = playerEl.classList.contains('hidden');
    playerEl.classList.remove('hidden');
    playerEl.style.position = 'fixed'; playerEl.style.bottom = '0'; playerEl.style.left = '0'; playerEl.style.right = '0'; playerEl.style.zIndex = '96';
  }
}
async function onLitLyricsEditorSave({ lyrics, chords }) {
  $('lyrics').value = lyrics; $('chords').value = chords;
  if (currentFilePath) await window.api.lyricsSetSyncStatus(currentFilePath, 'local'); // editar quebra a sincronia
  await updateLyricsStatusCard();
  saveDetailsWithSync('local'); // grava as tags no MP3 + reload
}
function onLitLyricsEditorClose() {
  const playerEl = $('player');
  if (playerEl) {
    playerEl.style.position = ''; playerEl.style.bottom = ''; playerEl.style.left = ''; playerEl.style.right = '';
    playerEl.style.zIndex = '';
    if (_leLitPlayerWasHidden) playerEl.classList.add('hidden');
  }
}

// --- Abrir o editor ---
// Editor de letra = ilha Lit <syn-lyrics-editor> (modal próprio no body).
function openLyricsEditor() {
  openLyricsEditorLit();
}

// Salvar (sobrescreve o arquivo) e voltar para a visualização de detalhes
async function saveDetails() {
  if (!currentFilePath) return;
  const payload = {
    filePath: currentFilePath,
    imagePath: currentImagePath,
    imageDataUrl: currentImageDataUrl,
    source: 'file',
    fields: {}
  };
  fields.forEach((f) => { payload.fields[f] = $(f) ? $(f).value.trim() : ''; });
  // Preserva o status de sincronização atual (não altera ao salvar metadados normais)
  payload.fields.lrclibSync = null;

  const saveBtnEl = $('editDone'); // o topo-direito é agora o único botão de salvar
  const origInner = saveBtnEl ? saveBtnEl.innerHTML : null;
  if (saveBtnEl) {
    saveBtnEl.disabled = true;
    saveBtnEl.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="le-spin"><circle cx="12" cy="12" r="10" stroke-dasharray="40" stroke-dashoffset="10"/></svg>';
  }
  showLoading(t('editor.savingTags'));
  await paint();
  // a faixa tocando será reescrita in-place → suprime o erro transitório do stream
  if (current && current.filePath === currentFilePath) audioReloading = true;
  let res;
  try {
    res = await window.api.saveTags(payload);
  } catch (err) {
    toast(t('editor.saveFail', { msg: (err && err.message ? err.message : err) }), 'error');
    return;
  } finally {
    hideLoading();
    if (saveBtnEl) saveBtnEl.disabled = false;
  }
  if (res.error) { toast(res.error, 'error'); return; }
  // Feedback visual: checkmark verde por 1s, depois restaura o ícone original
  if (saveBtnEl && origInner) {
    saveBtnEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#34c759" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M20 6 9 17l-5-5"/></svg>';
    await new Promise((r) => setTimeout(r, 600));
    saveBtnEl.innerHTML = origInner;
  }
  toast(t('editor.saved'), 'success');
  // a capa pode ter sido adicionada/trocada: esquece o estado anterior
  coverState.delete(currentFilePath);
  if (res.savedPath) coverState.delete(res.savedPath);
  await reloadLibrary();
  maybeResync(); // propaga a edição ao dispositivo, se houver sync ativa
  // mantém o editor aberto e volta para a visualização com os dados atualizados
  if (currentEditorSong) {
    const updated = songs.find((x) => x.filePath === currentFilePath);
    if (updated) currentEditorSong = updated;
  }
  // se a faixa editada é a que está tocando, recarrega o karaokê
  if (current && current.filePath === currentFilePath) { npLyricsPath = null; loadCurrentLyrics(current.filePath); reloadCurrentAudio(); }
  renderEditorView();
  $('editor').classList.remove('edit-mode');
  $('editor').classList.add('view-mode');
}

// Variante que também escreve o status de sincronização no MP3
async function saveDetailsWithSync(lrclibSync) {
  if (!currentFilePath) return;
  const payload = {
    filePath: currentFilePath,
    imagePath: currentImagePath,
    imageDataUrl: currentImageDataUrl,
    source: 'file',
    fields: {}
  };
  fields.forEach((f) => { payload.fields[f] = $(f) ? $(f).value.trim() : ''; });
  payload.fields.lrclibSync = lrclibSync;

  // a faixa tocando será reescrita in-place → suprime o erro transitório do stream
  if (current && current.filePath === currentFilePath) audioReloading = true;
  try {
    const res = await window.api.saveTags(payload);
    if (res && res.error) console.warn('[saveDetailsWithSync]', res.error);
  } catch (err) {
    console.warn('[saveDetailsWithSync]', err);
  }
  // Atualiza card de status após salvar
  await updateLyricsStatusCard();
  coverState.delete(currentFilePath); // capa pode ter mudado
  await reloadLibrary();
  maybeResync();
  if (current && current.filePath === currentFilePath) { npLyricsPath = null; loadCurrentLyrics(current.filePath); reloadCurrentAudio(); }
}

// Excluir música (botão dentro do editor) — abre a mesma modal de exclusão.
// (#editDone e #deleteBtn são tratados pelo roteador delegado do #editorBackdrop)
function onDeleteClick() {
  if (!currentFilePath) return;
  const s = songs.find((x) => x.filePath === currentFilePath)
    || deviceOnlySongs.find((x) => x.filePath === currentFilePath)
    || { filePath: currentFilePath, fileName: $('fileName').textContent, title: $('title').value, artist: $('artist').value };
  hideEditor();
  openDeleteModal(s);
}

// ====================== Menu de opções da música (⋯) ======================
let songMenuDocHandler = null;
function closeSongMenu() {
  const m = document.getElementById('songContext');
  if (m) m.remove();
  if (songMenuDocHandler) {
    document.removeEventListener('click', songMenuDocHandler);
    window.removeEventListener('resize', closeSongMenu);
    songMenuDocHandler = null;
  }
}
function openSongMenu(s, anchorEl) {
  closeSongMenu();
  const menu = document.createElement('div');
  menu.id = 'songContext';
  menu.className = 'song-context';

  const det = document.createElement('button');
  det.className = 'ctx-item';
  det.innerHTML = `${ICONS.edit}<span>${t('menu.details')}</span>`;
  det.addEventListener('click', (e) => { e.stopPropagation(); closeSongMenu(); openEditor(s); });

  const nxt = document.createElement('button');
  nxt.className = 'ctx-item';
  nxt.innerHTML = `${ICONS.next}<span>${t('menu.playNext')}</span>`;
  nxt.addEventListener('click', (e) => { e.stopPropagation(); closeSongMenu(); enqueueNext(s); });

  const addpl = document.createElement('button');
  addpl.className = 'ctx-item';
  addpl.innerHTML = `${ICONS.queue}<span>${t('playlists.addToMenu')}</span>`;
  addpl.addEventListener('click', (e) => { e.stopPropagation(); openAddToPlaylistMenu(s, anchorEl); });

  const del = document.createElement('button');
  del.className = 'ctx-item danger';
  del.innerHTML = `${ICONS.trash}<span>${t('common.delete')}</span>`;
  del.addEventListener('click', (e) => { e.stopPropagation(); closeSongMenu(); openDeleteModal(s); });

  menu.append(det, nxt, addpl, del);
  document.body.appendChild(menu);

  const r = anchorEl.getBoundingClientRect();
  const mw = 160, mh = 132;
  let left = r.right - mw; if (left < 8) left = 8;
  let top = r.bottom + 4; if (top + mh > window.innerHeight - 8) top = r.top - mh - 4;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  songMenuDocHandler = (e) => {
    const m = document.getElementById('songContext');
    if (m && !m.contains(e.target)) closeSongMenu();
  };
  setTimeout(() => {
    document.addEventListener('click', songMenuDocHandler);
    window.addEventListener('resize', closeSongMenu);
  }, 0);
}

// ====================== Modal de exclusão (dispositivo / PC / ambos) ======================
let deleteTarget = null;

function openDeleteModal(s) {
  deleteTarget = s;
  const title = s.title || (s.fileName || '').replace(/\.mp3$/i, '');
  $('deleteSong').textContent = `${s.artist ? s.artist + ' — ' : ''}${title}`;

  const onPc = !s.deviceOnly;
  const onDevice = !!s.deviceOnly || !!(activeDevice && syncedKeys.has(keyOf(s)));
  const nick = activeDevice ? (activeDevice.nickname || activeDevice.label || t('deleteModal.deviceFallback')) : t('deleteModal.deviceFallback');

  const opts = $('deleteOptions');
  const btnDevice = opts.querySelector('[data-where="device"]');
  const btnPc = opts.querySelector('[data-where="pc"]');
  const btnBoth = opts.querySelector('[data-where="both"]');

  btnDevice.dataset.label = t('deleteModal.onDevice', { name: nick });
  btnPc.dataset.label = t('deleteModal.pcOnly');
  btnBoth.dataset.label = t('deleteModal.both');

  opts.classList.remove('confirming');
  [btnDevice, btnPc, btnBoth].forEach((b) => {
    b.classList.remove('confirming');
    b.dataset.confirm = '';
    b.textContent = b.dataset.label;
  });

  btnDevice.classList.toggle('hidden', !onDevice);
  btnPc.classList.toggle('hidden', !onPc);
  btnBoth.classList.toggle('hidden', !(onPc && onDevice));

  $('deleteModal').classList.remove('hidden', 'closing');
}

function closeDeleteModal() {
  closeViewAnimated($('deleteModal'));
  const opts = $('deleteOptions');
  opts.classList.remove('confirming');
  opts.querySelectorAll('.del-opt').forEach((b) => {
    b.classList.remove('confirming');
    b.dataset.confirm = '';
    if (b.dataset.label) b.textContent = b.dataset.label;
  });
  deleteTarget = null;
}

// 1º clique: morph para confirmação; 2º clique: efetiva
$('deleteOptions').addEventListener('click', (e) => {
  const b = e.target.closest('.del-opt');
  if (!b || b.classList.contains('hidden')) return;
  if (b.dataset.confirm === '1') {
    executeDelete(b.dataset.where);
  } else {
    b.dataset.confirm = '1';
    b.classList.add('confirming');
    $('deleteOptions').classList.add('confirming');
    b.textContent = t('deleteModal.confirm');
  }
});

$('deleteCancel').addEventListener('click', closeDeleteModal);
$('deleteModal').addEventListener('click', (e) => { if (e.target === $('deleteModal')) closeDeleteModal(); });

async function executeDelete(where) {
  const s = deleteTarget;
  if (!s) { closeDeleteModal(); return; }
  const serial = activeDevice ? activeDevice.serial : (s.serial || null);
  let hadError = false;

  try {
    if ((where === 'pc' || where === 'both') && !s.deviceOnly) {
      const r = await window.api.libraryDelete(s.filePath);
      if (r && r.error) { toast(r.error, 'error'); hadError = true; }
    }
    if ((where === 'device' || where === 'both') && serial) {
      const payload = s.deviceOnly ? { serial, deviceFilePath: s.filePath } : { serial, pcFilePath: s.filePath };
      const r = await window.api.deviceDeleteTrack(payload);
      if (r && r.error) { toast(r.error, 'error'); hadError = true; }
    }
  } catch (err) {
    toast(t('deleteModal.fail', { msg: (err && err.message ? err.message : err) }), 'error');
    hadError = true;
  }

  closeDeleteModal();

  // atualiza estado local (faixa device-only some; badges refletem a remoção)
  if (where === 'device' || where === 'both') {
    if (s.deviceOnly) deviceOnlySongs = deviceOnlySongs.filter((x) => x.filePath !== s.filePath);
    if (activeDevice) {
      try { const st = await window.api.deviceSyncState(activeDevice.serial); syncedKeys = new Set(st.keys || []); } catch { /* ok */ }
    }
  }
  await reloadLibrary();
  if (!hadError) toast(t('deleteModal.deleted'), 'success');
}

// ====================== Cropper de capa ======================
// Cropper = ilha Lit <syn-cropper> (carrega/enquadra/recorta sozinha). Não consome context
// (só compõe syn-range) → monta direto no #cropModal, sem app-root.
let _litCropper = null;
function ensureLitCropper() {
  if (_litCropper) return;
  const sheet = document.querySelector('#cropModal .crop-sheet');
  if (!sheet) return;
  // esconde os controles legados do #cropModal (markup removido no cluster F)
  const stage = $('cropStage'); if (stage) stage.style.display = 'none';
  const ctrls = sheet.querySelector('.crop-controls'); if (ctrls) ctrls.style.display = 'none';
  const actions = sheet.querySelector('.sheet-actions'); if (actions) actions.style.display = 'none';
  const c = document.createElement('syn-cropper');
  c.applyLabel = t('crop.apply');
  c.cancelLabel = t('common.cancel');
  c.addEventListener('syn:cover:crop', (e) => {
    currentImageDataUrl = e.detail.dataUrl;
    currentImagePath = null;
    showCoverPreview(currentImageDataUrl);
    closeCropper();
  });
  c.addEventListener('syn:cover:cancel', () => closeCropper());
  sheet.appendChild(c);
  _litCropper = c;
}

function openCropper() {
  if (!coverSourceDataUrl) return;
  // ilha Lit syn-cropper: o componente carrega/enquadra/recorta sozinho
  ensureLitCropper();
  _litCropper.src = coverSourceDataUrl;
  $('cropModal').classList.remove('hidden', 'closing');
}
function closeCropper() { closeViewAnimated($('cropModal')); }

$('cropModal').addEventListener('click', (e) => { if (e.target === $('cropModal')) closeCropper(); });

// ====================== Configurações ======================
const modal = $('settingsModal');
// Nomes de exibição dos idiomas (fallback: código em maiúsculas)
const LANG_NAMES = { en: 'English', pt: 'Português', 'pt-br': 'Português (Brasil)', 'pt-pt': 'Português (Portugal)', es: 'Español', fr: 'Français', de: 'Deutsch', it: 'Italiano', ru: 'Русский', ja: '日本語', zh: '中文' };
let langConfigured = 'auto'; // idioma salvo ('auto' = detectar pelo locale do SO)
async function populateLanguageSelect() {
  let info = {};
  try { info = await window.api.getI18n(); } catch { /* usa padrões */ }
  const available = Array.isArray(info.available) ? info.available : [];
  langConfigured = info.configured ? String(info.configured).toLowerCase() : 'auto';
  const sel = $('language');
  sel.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = 'auto'; auto.textContent = t('settings.languageAuto');
  sel.appendChild(auto);
  for (const code of available) {
    const o = document.createElement('option');
    o.value = code; o.textContent = LANG_NAMES[code] || code.toUpperCase();
    sel.appendChild(o);
  }
  sel.value = available.includes(langConfigured) ? langConfigured : 'auto';
}

$('settingsBtn').addEventListener('click', async () => {
  const cfg = await window.api.getConfig();
  await populateLanguageSelect();
  $('apiKey').value = cfg.apiKey || '';
  $('useAi').checked = cfg.useAi !== false; // padrão: ligado (compat. instalações antigas)
  $('advancedEdit').checked = cfg.advancedEdit === true; // padrão: desligado
  // integração CLI: só exibe o switch se o Syntune CLI estiver instalado
  try {
    const cli = await window.api.cliDetect();
    $('cliAiRow').classList.toggle('hidden', !cli.installed);
    $('useCliAi').checked = cfg.useCliAi === true;
  } catch { $('cliAiRow').classList.add('hidden'); }
  $('geniusToken').value = cfg.geniusToken || '';
  $('lastfmApiKey').value = cfg.lastfmApiKey || '';
  $('lastfmSecret').value = cfg.lastfmSecret || '';
  $('lastfmScrobbleEnabled').checked = !!cfg.lastfmScrobbleEnabled;
  $('lastfmSessionKey').value = cfg.lastfmSessionKey || '';
  $('lastfmScrobbleFields').classList.toggle('hidden', !cfg.lastfmScrobbleEnabled);
  $('model').value = cfg.model || 'gemini-2.5-flash';
  $('downloadFolder').value = cfg.downloadFolder || '';
  try { $('appVersion').textContent = t('settings.version', { v: await window.api.getVersion() }); } catch {}
  upgradeSettingsAccordion(); // troca as seções por <syn-setting-section> (no bundle); idempotente
  modal.classList.remove('hidden', 'closing');
});
$('browseFolder').addEventListener('click', async () => {
  const dir = await window.api.selectFolder();
  if (dir) $('downloadFolder').value = dir;
});
$('clearFolder').addEventListener('click', () => { $('downloadFolder').value = ''; });
$('cancelSettings').addEventListener('click', () => closeViewAnimated(modal));
modal.addEventListener('click', (e) => { if (e.target === modal) closeViewAnimated(modal); });

// Accordion das Configurações: 1 seção aberta por vez. Clicar numa seção fecha as
// demais; clicar na já aberta a recolhe.
$('settingsAcc').addEventListener('click', (e) => {
  const head = e.target.closest('.acc-head');
  if (!head) return; // após o upgrade Lit não há .acc-head → no-op (o componente cuida do toggle)
  const item = head.parentElement;
  const wasOpen = item.classList.contains('open');
  $('settingsAcc').querySelectorAll('.acc-item.open').forEach((el) => el.classList.remove('open'));
  if (!wasOpen) item.classList.add('open');
});

// Troca cada .acc-item legado por <syn-setting-section>, MOVENDO o corpo (.acc-body, com os
// inputs cujos IDs o renderer lê/escreve) p/ dentro do slot. O componente provê header +
// toggle. Idempotente.
function upgradeSettingsAccordion() {
  const acc = $('settingsAcc');
  if (!acc) return;
  for (const item of [...acc.querySelectorAll(':scope > .acc-item')]) {
    const span = item.querySelector('.acc-head span');
    const body = item.querySelector('.acc-body');
    if (!body) continue;
    const sec = document.createElement('syn-setting-section');
    sec.heading = span ? span.textContent : '';
    sec.open = item.classList.contains('open');
    while (body.firstChild) sec.appendChild(body.firstChild); // preserva os inputs (IDs)
    acc.replaceChild(sec, item);
  }
}

// Single-open (espelha o legado): ao abrir uma seção, fecha as demais.
$('settingsAcc').addEventListener('syn:setting:toggle', (e) => {
  if (!e.detail || !e.detail.open) return;
  $('settingsAcc').querySelectorAll('syn-setting-section').forEach((s) => {
    if (s !== e.target) s.open = false;
  });
});

$('lastfmScrobbleEnabled').addEventListener('change', (e) => {
  $('lastfmScrobbleFields').classList.toggle('hidden', !e.target.checked);
});

// Switch "Usar IA no Syntune CLI?" — ação imediata (não espera o Salvar).
// Ligar: modal de confirmação informando que a chave irá p/ a var STUNE_API_KEY.
// Desligar: remove a var. A var é (re)gravada ao salvar a chave, se o switch estiver ligado.
$('useCliAi').addEventListener('change', async (e) => {
  const on = e.target.checked;
  if (on && !confirm(t('settings.cliAiConfirm'))) {
    e.target.checked = false; // usuário recusou → reverte
    return;
  }
  try {
    const res = await window.api.cliSetAiEnabled(on);
    if (on) {
      // a chave já configurada vira a var agora; senão, será gravada ao salvar a chave
      toast(res.hasKey ? t('settings.cliAiOnWithKey') : t('settings.cliAiOnNoKey'), 'success');
    } else {
      toast(t('settings.cliAiOff'), 'success');
    }
  } catch {
    e.target.checked = !on; // falhou → reverte estado visual
    toast(t('settings.cliAiError'), 'error');
  }
});

$('btnAuthLastfm').addEventListener('click', async () => {
  const apiKey = $('lastfmApiKey').value.trim();
  const secret = $('lastfmSecret').value.trim();
  if (!apiKey || !secret) {
    $('lastfmAuthHint').textContent = t('settings.lastfmAuthMissing');
    return;
  }
  $('lastfmAuthHint').textContent = t('settings.lastfmAuthWaiting');
  const res = await window.api.lastfmAuthSession({ apiKey, secret });
  if (res.error) {
    $('lastfmAuthHint').textContent = t('settings.lastfmAuthError', { msg: res.error });
  } else {
    $('lastfmSessionKey').value = res.sessionKey;
    $('lastfmAuthHint').textContent = t('settings.lastfmAuthLinked', { user: res.username });
  }
});
$('saveSettings').addEventListener('click', async () => {
  const prevGenius = (await window.api.getConfig()).geniusToken || '';
  const prevLastfm = (await window.api.getConfig()).lastfmApiKey || '';
  const geniusToken = $('geniusToken').value.trim();
  const lastfmApiKey = $('lastfmApiKey').value.trim();
  await window.api.setConfig({
    apiKey: $('apiKey').value.trim(),
    useAi: $('useAi').checked,
    advancedEdit: $('advancedEdit').checked,
    geniusToken,
    lastfmApiKey,
    lastfmSecret: $('lastfmSecret').value.trim(),
    lastfmScrobbleEnabled: $('lastfmScrobbleEnabled').checked,
    lastfmSessionKey: $('lastfmSessionKey').value.trim(),
    model: $('model').value,
    downloadFolder: $('downloadFolder').value.trim()
  });
  // troca de idioma: aplica reiniciando o app (o relaunch encerra a execução aqui)
  const langSel = $('language').value;
  if (langSel !== langConfigured) {
    await window.api.setLanguage(langSel === 'auto' ? '' : langSel);
    return;
  }
  advancedEdit = $('advancedEdit').checked; // reflete na sessão imediatamente
  if (npOpen()) {
    if ($('nowPlaying').classList.contains('lyrics-mode')) renderNpLyrics(); // aplica/remove gutters
    updateChordsBtn();
  }
  closeViewAnimated(modal);
  toast(t('settings.saved'), 'success');
  // se o token do Genius mudou, limpa o cache em memória p/ buscar fotos novamente
  if (geniusToken !== prevGenius) {
    for (const k of Object.keys(artistImgCache)) delete artistImgCache[k];
  }
  // se a chave do Last.fm mudou, limpa o cache de reproduções globais
  if (lastfmApiKey !== prevLastfm) {
    for (const k of Object.keys(globalPlaycountCache)) delete globalPlaycountCache[k];
  }
  await reloadLibrary(); // a pasta pode ter mudado
});

// ====================== Player ======================
// Ícones SVG inline (estilo traço fino, herdam a cor via currentColor).

// Clave de Sol — ícone do botão de acordes no Now Playing (karaokê).
const LE_ICON_CLEF = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M13.1 2c-1.7 0-2.9 1.5-2.9 3.4 0 1 .2 2 .5 3.1-2 1.6-3.2 3.4-3.2 5.6 0 2.6 1.9 4.6 4.5 4.6.4 0 .8 0 1.2-.1l.3 2.1c.2 1.4-.5 2.2-1.6 2.2-.8 0-1.4-.4-1.6-1 .6-.1 1-.6 1-1.2 0-.7-.6-1.3-1.3-1.3-.8 0-1.4.6-1.4 1.5 0 1.5 1.3 2.6 3.2 2.6 1.9 0 3.2-1.3 2.9-3.3l-.3-2.2c1.6-.6 2.6-2 2.6-3.6 0-1.8-1.3-3.2-3.1-3.2-.3 0-.5 0-.8.1l-.4-2.6c1.1-1.1 1.8-2.3 1.8-3.8C14.9 3.2 14.1 2 13.1 2zm-.2 1.3c.5 0 .8.6.8 1.4 0 .9-.4 1.8-1.1 2.6-.2-.8-.4-1.6-.4-2.3 0-1 .3-1.7.7-1.7zm.6 7.8c1.1 0 1.9.9 1.9 2.1 0 1-.6 1.9-1.6 2.3l-.6-4.3c.1 0 .2-.1.3-.1zm-1.5.4l.6 4.4c-.2 0-.5.1-.7.1-1.8 0-3.1-1.4-3.1-3.2 0-1.4.8-2.6 2.1-3.6.2.8.6 1.5 1 2.3z"/></svg>';

function applyPlayerIcons() {
  $('shuffleBtn').innerHTML = ICONS.shuffle;
  $('prevBtn').innerHTML = ICONS.prev;
  $('nextBtn').innerHTML = ICONS.next;
  $('repeatBtn').innerHTML = ICONS.repeat;
  $('queueBtn').innerHTML = ICONS.queue;
  $('eqBtn').innerHTML = ICONS.eq;
  $('playerExpand').innerHTML = ICONS.expandUp;
  $('eqClose').innerHTML = ICONS.close;
  $('eqDelete').innerHTML = ICONS.trash;
  $('playerClose').innerHTML = ICONS.close;
  $('queueClose').innerHTML = ICONS.close;
  document.querySelector('.pl-vol-icon').innerHTML = ICONS.volume;
  // Now Playing
  $('npCollapse').innerHTML = ICONS.chevronDown;
  $('npLyricsBtn').innerHTML = ICONS.lyrics;
  $('npChordsBtn').innerHTML = LE_ICON_CLEF;
  $('npFullscreen').innerHTML = ICONS.maximize;
  $('npQueueBtn').innerHTML = ICONS.queue;
  $('npEqBtn').innerHTML = ICONS.eq;
  $('npShuffle').innerHTML = ICONS.shuffle;
  $('npPrev').innerHTML = ICONS.prev;
  $('npNext').innerHTML = ICONS.next;
  $('npRepeat').innerHTML = ICONS.repeat;
  $('npVolIcon').innerHTML = ICONS.volume;
  updatePlayButton();
}

const audio = new Audio();
// O áudio vem do protocolo custom mp3file:// (outra origem). Para roteá-lo pelo
// grafo Web Audio (createMediaElementSource) sem o Chromium silenciar a fonte por
// "cross-origin taint", o elemento precisa ser CORS-clean. O handler já envia
// Access-Control-Allow-Origin: *, então 'anonymous' basta. (Regressão exposta no
// Electron 41 / Chromium novo, que passou a impor isso de forma estrita.)
audio.crossOrigin = 'anonymous';

// ---- Visualizador de espectro (Web Audio API) ----
// Liga o <audio> a um AnalyserNode e desenha as frequências num canvas atrás
// do conteúdo do card. IMPORTANTE: ao criar o MediaElementSource o áudio passa
// a fluir pelo grafo — por isso o AudioContext precisa estar "running" (resume).
let audioCtx = null, analyser = null, sourceNode = null, freqData = null;
// Equalizador de 6 bandas (2 graves, 2 médios, 2 agudos) via BiquadFilter
let eqFilters = null;
let eqGains = [0, 0, 0, 0, 0, 0];
let eqEnabled = false;
let eqPresets = []; // presets do usuário
let _litEq = null;  // ilha Lit do EQ (bandas+toggle), quando montada (bundle)

function ensureAnalyser() {
  if (analyser) { if (audioCtx.state === 'suspended') audioCtx.resume(); return; }
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    sourceNode = audioCtx.createMediaElementSource(audio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128;               // 64 bins de frequência
    analyser.smoothingTimeConstant = 0.82; // suaviza o movimento das barras
    // cadeia de equalização entre a fonte e o analisador (o visualizador reflete o EQ)
    eqFilters = EQ_BANDS.map((b) => {
      const flt = audioCtx.createBiquadFilter();
      flt.type = b.type;
      flt.frequency.value = b.f;
      if (b.type === 'peaking') flt.Q.value = 1.0;
      flt.gain.value = 0;
      return flt;
    });
    let node = sourceNode;
    for (const flt of eqFilters) { node.connect(flt); node = flt; }
    node.connect(analyser);
    analyser.connect(audioCtx.destination);
    freqData = new Uint8Array(analyser.frequencyBinCount);
    if (_litViz) { _litViz.analyser = analyser; _litViz.freqData = freqData; }
    applyEq();
    audioCtx.resume();
  } catch { analyser = null; }
}

// HSL helpers p/ derivar as cores das barras a partir da paleta da capa
// cores das barras: fiéis à paleta da capa (MESMO matiz), com saturação preservada
// e o contraste vindo só da luminosidade — deslocada na direção do texto do card
// (clareia sobre capa escura, escurece sobre capa clara) para "destoar" do fundo.

let vizCard = null, vizCanvas = null, vizCtx = null, vizRAF = null;

// paleta-alvo (cor da capa atual) + cores correntes que interpolam suavemente
// até a alvo a cada frame — assim a cor das barras transiciona ao trocar de música.
let barTargetPal = { r: 124, g: 92, b: 255, text: '#ffffff' };
let vizCurPal = null;
let npCurPal = null;

function resizeViz() {
  if (!vizCanvas || !vizCard) return;
  const rect = vizCard.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  vizCanvas.width = Math.max(1, Math.round(rect.width * dpr));
  vizCanvas.height = Math.max(1, Math.round(rect.height * dpr));
}

function drawViz() {
  if (!vizCanvas || !analyser) { vizRAF = null; return; }
  const ctx = vizCtx;
  const w = vizCanvas.width, h = vizCanvas.height;
  ctx.clearRect(0, 0, w, h);
  analyser.getByteFrequencyData(freqData);

  const bins = freqData.length;
  const bars = Math.min(44, bins);
  const usable = Math.floor(bins * 0.85); // descarta as frequências mais altas (quase sempre fracas)
  const step = Math.max(1, Math.floor(usable / bars));
  const gap = Math.max(1, w * 0.004);
  const bw = (w - gap * (bars - 1)) / bars;
  const r = Math.min(bw / 2, h * 0.02);
  vizCurPal = lerpPal(vizCurPal, barTargetPal, 0.09); // transição suave ao trocar de música
  const colors = deriveBarColors(vizCurPal);

  for (let i = 0; i < bars; i++) {
    let v = 0; for (let k = 0; k < step; k++) v += freqData[i * step + k] || 0; v /= step;
    const bh = Math.max(h * 0.03, (v / 255) * h * 0.96);
    const x = i * (bw + gap);
    const y = h - bh;
    const grad = ctx.createLinearGradient(0, y, 0, h);
    grad.addColorStop(0, colors.top);
    grad.addColorStop(1, colors.bottom);
    ctx.fillStyle = grad;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, bw, bh, [r, r, 0, 0]);
    else ctx.rect(x, y, bw, bh);
    ctx.fill();
  }
  vizRAF = requestAnimationFrame(drawViz);
}

function startVisualizer(cardEl) {
  ensureAnalyser();
  if (!analyser) return;
  // mesmo card já animando: nada a refazer (a cor interpola sozinha via barTargetPal)
  if (vizCard === cardEl && vizRAF) return;
  stopVisualizerLoop();
  if (vizCanvas && vizCanvas.parentElement) vizCanvas.remove();
  vizCard = cardEl;
  vizCanvas = document.createElement('canvas');
  vizCanvas.className = 'viz';
  cardEl.insertBefore(vizCanvas, cardEl.firstChild);
  vizCtx = vizCanvas.getContext('2d');
  resizeViz();
  vizRAF = requestAnimationFrame(drawViz);
}

function stopVisualizerLoop() {
  if (vizRAF) { cancelAnimationFrame(vizRAF); vizRAF = null; }
}
function pauseVisualizer() { stopVisualizerLoop(); } // congela o último quadro
function stopVisualizer() {
  stopVisualizerLoop();
  if (vizCanvas && vizCanvas.parentElement) vizCanvas.remove();
  vizCanvas = null; vizCtx = null; vizCard = null;
}

window.addEventListener('resize', () => { if (vizCanvas) resizeViz(); });

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// preenche o trilho do slider (--fill em %) conforme o valor atual
function rangeFill(el) {
  if (!el) return;
  const min = parseFloat(el.min) || 0;
  const max = parseFloat(el.max);
  const v = parseFloat(el.value) || 0;
  const pct = (isFinite(max) && max > min) ? ((v - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--fill', pct + '%');
}

// destaca o card que está tocando e monta o visualizador de espectro nele
function markPlayingCards() {
  document.querySelectorAll('.song-card.playing').forEach((el) => el.classList.remove('playing', 'paused'));
  if (!current) { stopVisualizer(); return; }
  const sel = (window.CSS && CSS.escape) ? CSS.escape(current.filePath) : current.filePath;
  const el = document.querySelector(`.song-card[data-path="${sel}"]`);
  if (!el) { stopVisualizer(); return; }
  el.classList.add('playing');
  if (isPlaying) {
    startVisualizer(el, current.coverDataUrl);
  } else {
    el.classList.add('paused');
    pauseVisualizer(); // congela as barras no último quadro
  }
}

// monta a capa de um container do player com fallback p/ placeholder
function setCoverEl(container, song) {
  if (coverState.get(song.filePath) === false) {
    container.innerHTML = '<span class="ph">♪</span>';
    return;
  }
  const img = document.createElement('img');
  img.alt = '';
  img.onerror = () => {
    coverState.set(song.filePath, false);
    container.innerHTML = '<span class="ph">♪</span>';
  };
  img.src = coverUrl(song);
  container.innerHTML = '';
  container.appendChild(img);
}

function updatePlayerMeta() {
  if (!current) return;
  const title = current.title || (current.fileName || '').replace(/\.mp3$/i, '') || '—';
  const artist = current.artist || '';
  // player-half: null-guard (após o swap p/ syn-mini-player esses ids somem; a facade abaixo dirige)
  { const e = $('playerTitle'); if (e) e.textContent = title; }
  { const e = $('playerArtist'); if (e) e.textContent = artist; }
  { const e = $('playerCover'); if (e) setCoverEl(e, current); }
  $('npTitle').textContent = title;
  $('npArtist').textContent = artist;
  setCoverEl($('npCover'), current);
  // tinge a UI com a cor da capa (null se sabidamente sem capa)
  applyNowColor(coverState.get(current.filePath) === false ? null : coverUrl(current));
  // facade: estado discreto p/ os componentes do player (sub-passo 1 da Fase D)
  if (_litPlayer) _litPlayer.setState({ title, artist, current, coverUrl: coverState.get(current.filePath) === false ? null : coverUrl(current) });
}

// cor dinâmica da capa atual: define a cor-alvo (barras interpolam até ela) e os
// canais CSS animáveis (fundo/ambiente transicionam via @property). A capa em si já
// foi trocada na hora em updatePlayerMeta — aqui só a COR muda de forma suave.
let nowColorSeq = 0; // descarta paletas que chegam atrasadas após trocar de faixa
async function applyNowColor(dataUrl) {
  const seq = ++nowColorSeq;
  const pal = dataUrl ? await getPalette(dataUrl) : null;
  if (seq !== nowColorSeq) return;
  const r = pal ? pal.r : 124, g = pal ? pal.g : 92, b = pal ? pal.b : 255;
  const s = document.documentElement.style;
  s.setProperty('--now-r', String(r));
  s.setProperty('--now-g', String(g));
  s.setProperty('--now-b', String(b));
  barTargetPal = { r, g, b, text: pal ? pal.text : '#ffffff' };
  if (_litViz) _litViz.palette = barTargetPal; // o anel interpola até esta paleta
  // a paleta chega async: atualiza o accent dos acordes sem re-render (o rAF o consome)
  npChordAccent = chordAccentRGB(barTargetPal);
  const lyBox = $('npLyrics');
  if (lyBox) lyBox.style.setProperty('--chord-accent', npChordAccent.join(','));
}

function updatePlayButton() {
  const ic = isPlaying ? ICONS.pause : ICONS.play;
  { const e = $('playBtn'); if (e) e.innerHTML = ic; }
  $('npPlay').innerHTML = ic;
  if (_litPlayer) _litPlayer.setState({ isPlaying });
}

let loadSeq = 0; // protege contra trocas rápidas: descarta a faixa anterior
async function loadAndPlay(song) {
  const seq = ++loadSeq;
  // usa protocolo nativo: sem cópia de buffer via IPC
  audio.src = 'mp3file://' + encodeURIComponent(song.filePath);
  window.currentScrobbled = false;
  window.currentScrobbleTimestamp = Math.floor(Date.now() / 1000);
  if (seq !== loadSeq) return false;
  try { await audio.play(); } catch { /* autoplay/decode error */ }
  return true;
}

// Recarrega a faixa atual preservando posição/estado. Necessário após salvar tags na
// faixa que está TOCANDO: saveTags reescreve o MP3 in-place e os offsets do arquivo
// mudam (sobretudo ao adicionar acordes/letra), o que faz o stream ao vivo via
// mp3file:// falhar a decodificação ("erro de reprodução"). O ?v= força o refetch.
function reloadCurrentAudio() {
  if (!current) return;
  const pos = audio.currentTime || 0;
  const wasPlaying = !audio.paused;
  audioReloading = true;
  const done = () => { audioReloading = false; };
  const onMeta = () => {
    audio.removeEventListener('loadedmetadata', onMeta);
    try { audio.currentTime = pos; } catch { /* ignora */ }
    if (wasPlaying) audio.play().catch(() => {});
    done();
  };
  audio.addEventListener('loadedmetadata', onMeta);
  setTimeout(done, 4000); // segurança: nunca deixa o erro suprimido para sempre
  audio.src = 'mp3file://' + encodeURIComponent(current.filePath) + '?v=' + Date.now();
}

// Avisa antes de trocar de faixa com edições de acordes não salvas. Retorna false
// (abortar) se o usuário cancelar; true caso contrário (sem edições, mesma faixa, ou OK).
function confirmChordSwitch(index) {
  if (!npChordsDirty) return true;
  const next = queue[index];
  if (!next || (current && next.filePath === current.filePath)) return true;
  return window.confirm(t('chords.confirmDiscard'));
}

async function playAt(index) {
  if (index < 0 || index >= queue.length) return;
  if (!confirmChordSwitch(index)) return; // edições de acordes não salvas: usuário cancelou
  queueIndex = index;
  current = queue[index];
  $('player').classList.remove('hidden', 'closing');
  updatePlayerMeta();
  flareAmbient(); // o ambiente da biblioteca respira na cor da nova faixa
  loadCurrentLyrics(current.filePath); // prepara o karaokê para a nova faixa
  const ok = await loadAndPlay(current);
  if (!ok) return;
  markPlayingCards();
  renderQueue();
}

// toca a partir de um card: a fila vem da lista de contexto (visível, ou a do artista)
function playFromCard(song, listOverride) {
  ensureAnalyser(); // cria/retoma o AudioContext dentro do gesto do usuário
  queue = (listOverride && listOverride.length ? listOverride : visibleList).slice();
  let idx = queue.findIndex((s) => s.filePath === song.filePath);
  if (idx < 0) { queue = [song]; idx = 0; } // faixa fora da lista visível: toca só ela
  playAt(idx);
}
// "Tocar a seguir": insere a faixa logo após a atual na fila (sem interromper)
function enqueueNext(s) {
  if (!current) { playFromCard(s); return; } // nada tocando: toca direto
  const existing = queue.findIndex((x) => x.filePath === s.filePath);
  if (existing === queueIndex) { toast(t('player.alreadyPlaying'), ''); return; }
  if (existing >= 0) {
    queue.splice(existing, 1);
    if (existing < queueIndex) queueIndex--;
  }
  queue.splice(queueIndex + 1, 0, s);
  renderQueue();
  const title = s.title || (s.fileName || '').replace(/\.mp3$/i, '');
  toast(t('player.playsNext', { title }), 'success');
}

// reordena a fila por arraste, preservando a faixa atual
function reorderQueue(from, to) {
  if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return;
  const [m] = queue.splice(from, 1);
  queue.splice(to, 0, m);
  if (queueIndex === from) queueIndex = to;
  else if (from < queueIndex && to >= queueIndex) queueIndex--;
  else if (from > queueIndex && to <= queueIndex) queueIndex++;
  renderQueue();
}

function removeFromQueue(i) {
  if (i === queueIndex) return; // a faixa atual não sai da fila
  queue.splice(i, 1);
  if (i < queueIndex) queueIndex--;
  renderQueue();
}

// toca uma lista de faixas a partir de um índice (cards de artista / botão Tocar)
function playList(list, idx = 0) {
  if (!list || !list.length) return;
  ensureAnalyser();
  queue = list.slice();
  playAt(idx >= 0 && idx < list.length ? idx : 0);
}

function togglePlay() {
  if (!current) {
    // nada carregado: começa pela lista visível
    if (visibleList.length) playFromCard(visibleList[0]);
    return;
  }
  ensureAnalyser(); // retoma o AudioContext dentro do gesto
  if (audio.paused) audio.play(); else audio.pause();
}

function nextIndex() {
  if (repeatMode === 'one') return queueIndex;
  if (shuffle) {
    if (queue.length <= 1) return queueIndex;
    let r;
    do { r = Math.floor(Math.random() * queue.length); } while (r === queueIndex);
    return r;
  }
  if (queueIndex + 1 < queue.length) return queueIndex + 1;
  return repeatMode === 'all' ? 0 : -1;
}

function playNext() {
  const i = nextIndex();
  if (i < 0) { isPlaying = false; updatePlayButton(); markPlayingCards(); return; }
  playAt(i);
}

function playPrev() {
  // se já passou de 3s, reinicia a faixa; senão volta uma
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (shuffle) { playAt(nextIndex()); return; }
  if (queueIndex - 1 >= 0) playAt(queueIndex - 1);
  else audio.currentTime = 0;
}

// ---- Eventos do elemento de áudio ----
audio.addEventListener('play', () => { isPlaying = true; updatePlayButton(); markPlayingCards(); syncNpViz(); syncPlViz(); });
audio.addEventListener('pause', () => { isPlaying = false; updatePlayButton(); markPlayingCards(); syncNpViz(); syncPlViz(); });
audio.addEventListener('ended', () => {
  // com acordes não salvos, não avança automaticamente (preservaria as edições): pausa e avisa
  if (npChordsDirty) { toast(t('chords.unsaved'), ''); isPlaying = false; updatePlayButton(); markPlayingCards(); return; }
  playNext();
});
audio.addEventListener('timeupdate', () => {
  if (audio.duration) {
    if (!window.currentScrobbled && (audio.currentTime > audio.duration / 2 || audio.currentTime > 240)) {
      window.currentScrobbled = true;
      // lê do objeto `current` (não do DOM — o mini-player Lit não tem #playerArtist)
      const tArtist = (current && current.artist) || '';
      const tTitle = (current && (current.title || (current.fileName || '').replace(/\.mp3$/i, ''))) || '';
      if (tArtist && tTitle) {
        window.api.lastfmScrobble({ artist: tArtist, title: tTitle, timestamp: window.currentScrobbleTimestamp });
      }
    }
    const pos = String(Math.round((audio.currentTime / audio.duration) * 1000));
    const t = fmtTime(audio.currentTime);
    { const e = $('seek'); if (e) { e.value = pos; rangeFill(e); } } // player-half: null-guard (mini-player Lit gere o seek via rAF)
    $('npSeek').value = pos;
    { const e = $('curTime'); if (e) e.textContent = t; }
    $('npCur').textContent = t;
    updateDurLabel();
    rangeFill($('npSeek'));
    if (npOpen() && $('nowPlaying').classList.contains('lyrics-mode')) updateKaraoke(audio.currentTime);
  }
});
audio.addEventListener('loadedmetadata', () => {
  $('npDur').textContent = fmtTime(audio.duration);
  updateDurLabel();
  rangeFill($('seek')); rangeFill($('npSeek'));
});
// Ignora o erro transitório enquanto a faixa tocando é reescrita+recarregada (save).
let audioReloading = false;
audio.addEventListener('error', () => {
  if (current && !audioReloading) toast(t('player.playbackError'), 'error');
});

// ---- Controles (espelhados entre o mini-player e a Now Playing) ----
function toggleShuffle() { shuffle = !shuffle; syncShuffleBtn(); }
function syncShuffleBtn() {
  { const e = $('shuffleBtn'); if (e) e.classList.toggle('active', shuffle); }
  $('npShuffle').classList.toggle('active', shuffle);
  if (_litPlayer) _litPlayer.setState({ shuffle });
}
function cycleRepeat() {
  repeatMode = repeatMode === 'off' ? 'all' : (repeatMode === 'all' ? 'one' : 'off');
  syncRepeatBtn();
}
function syncRepeatBtn() {
  const icon = repeatMode === 'one' ? ICONS.repeatOne : ICONS.repeat;
  const active = repeatMode !== 'off';
  const title = repeatMode === 'one' ? t('player.repeatTrack') : (repeatMode === 'all' ? t('player.repeatQueue') : t('player.repeat'));
  for (const id of ['repeatBtn', 'npRepeat']) {
    const el = $(id);
    if (el) { el.classList.toggle('active', active); el.innerHTML = icon; el.title = title; }
  }
  if (_litPlayer) _litPlayer.setState({ repeatMode });
}
function seekTo(v) {
  if (audio.duration) audio.currentTime = (v / 1000) * audio.duration;
  rangeFill($('seek')); rangeFill($('npSeek'));
}
function setVolume(v) {
  if (!isFinite(v)) return;
  audio.volume = v;
  { const e = $('vol'); if (e) { e.value = String(v); rangeFill(e); } }
  $('npVol').value = String(v); rangeFill($('npVol'));
  try { localStorage.setItem('player.volume', String(v)); } catch { /* ok */ }
  if (_litPlayer) _litPlayer.setState({ volume: v });
}

$('playBtn').addEventListener('click', togglePlay);
$('nextBtn').addEventListener('click', playNext);
$('prevBtn').addEventListener('click', playPrev);
$('shuffleBtn').addEventListener('click', toggleShuffle);
$('repeatBtn').addEventListener('click', cycleRepeat);
$('seek').addEventListener('input', () => seekTo(parseInt($('seek').value, 10)));
$('vol').addEventListener('input', () => setVolume(parseFloat($('vol').value)));
function closePlayerAction() {
  audio.pause();
  $('player').classList.add('hidden');
  $('queuePanel').classList.add('hidden');
  closeNowPlaying();
  current = null; isPlaying = false;
  markPlayingCards();
  stopPlViz();
}
$('playerClose').addEventListener('click', closePlayerAction);

// ====================== Mini-player vivo (footer) ======================
// Pulso de batida: a energia dos graves vira --beat (0..1), que acende a
// aura da capa, o botão play e a linha superior do player em tempo real.
let plVizRAF = null;
let plBeat = 0;

function drawPlBeat() {
  const player = $('player');
  if (!analyser || player.classList.contains('hidden')) { plVizRAF = null; return; }
  analyser.getByteFrequencyData(freqData);

  // energia dos graves → pulso (ataque rápido, queda suave)
  const nb = Math.max(4, freqData.length >> 5);
  let e = 0; for (let i = 0; i < nb; i++) e += freqData[i];
  e /= nb * 255;
  plBeat += (e - plBeat) * (e > plBeat ? 0.45 : 0.12);
  player.style.setProperty('--beat', plBeat.toFixed(3));

  plVizRAF = requestAnimationFrame(drawPlBeat);
}

function startPlViz() {
  if (plVizRAF) return;
  ensureAnalyser();
  if (!analyser) return;
  plVizRAF = requestAnimationFrame(drawPlBeat);
}
function stopPlViz() {
  if (plVizRAF) { cancelAnimationFrame(plVizRAF); plVizRAF = null; }
  plBeat = 0;
  $('player').style.setProperty('--beat', '0');
}
function syncPlViz() {
  if (isPlaying && !$('player').classList.contains('hidden')) startPlViz();
  else stopPlViz();
}

// ---- Bolha de tempo ao pairar no seek ----
const seekEl = $('seek');
const seekTipEl = $('seekTip');
seekEl.addEventListener('mouseenter', () => seekTipEl.classList.add('on'));
seekEl.addEventListener('mouseleave', () => seekTipEl.classList.remove('on'));
seekEl.addEventListener('mousemove', (e) => {
  if (!audio.duration) return;
  const r = seekEl.getBoundingClientRect();
  const pct = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  seekTipEl.textContent = fmtTime(pct * audio.duration);
  const host = seekEl.parentElement.getBoundingClientRect();
  seekTipEl.style.left = (e.clientX - host.left) + 'px';
});

// ---- Roda do mouse: volume na capa/controle, scrub no seek ----
function nudgeVolume(dir) {
  setVolume(Math.min(1, Math.max(0, audio.volume + dir * 0.05)));
}
const volWheel = (e) => { e.preventDefault(); nudgeVolume(e.deltaY < 0 ? 1 : -1); };
document.querySelector('.player .pl-vol').addEventListener('wheel', volWheel, { passive: false });
$('playerCover').addEventListener('wheel', volWheel, { passive: false });
seekEl.addEventListener('wheel', (e) => {
  if (!audio.duration) return;
  e.preventDefault();
  const step = e.deltaY < 0 ? 5 : -5; // 5s por "clique" da roda
  audio.currentTime = Math.min(audio.duration, Math.max(0, audio.currentTime + step));
}, { passive: false });

// ---- Duração clicável: alterna entre total e tempo restante ----
let showRemaining = false;
try { showRemaining = localStorage.getItem('player.showRemaining') === '1'; } catch { /* ok */ }
function updateDurLabel() {
  if (!audio.duration) return;
  const e = $('durTime'); // some após o swap (o mini-player Lit gere seu próprio rótulo)
  if (e) e.textContent = showRemaining ? '-' + fmtTime(audio.duration - audio.currentTime) : fmtTime(audio.duration);
}
$('durTime').addEventListener('click', (e) => {
  e.stopPropagation();
  showRemaining = !showRemaining;
  try { localStorage.setItem('player.showRemaining', showRemaining ? '1' : '0'); } catch { /* ok */ }
  updateDurLabel();
});

// ---- Fechamento elegante: fade rápido do volume antes de encerrar o app ----
// O main intercepta o close e pede o fade; respondemos quando o áudio silenciar.
// Loop por setTimeout (não rAF): segue rodando mesmo com a janela minimizada.
let appFadingOut = false;
window.api.onAppFadeout(() => {
  if (appFadingOut) return;
  appFadingOut = true;
  if (!current || audio.paused || audio.volume <= 0.01) { window.api.fadeoutDone(); return; }
  const v0 = audio.volume;
  const T = 320; // ms: rápido, mas sem corte abrupto
  const t0 = performance.now();
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / T);
    const rest = 1 - k;
    audio.volume = v0 * rest * rest; // queda quadrática: começa firme, termina suave
    if (k < 1) setTimeout(step, 16);
    else {
      try { audio.pause(); } catch { /* ok */ }
      window.api.fadeoutDone();
    }
  };
  step();
});

// ---- Ondulação tátil nos botões do player ----
$('player').addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('.pl-btn');
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  const d = Math.max(r.width, r.height) * 1.1;
  const rip = document.createElement('span');
  rip.className = 'pl-ripple';
  rip.style.width = rip.style.height = d + 'px';
  rip.style.left = (e.clientX - r.left - d / 2) + 'px';
  rip.style.top = (e.clientY - r.top - d / 2) + 'px';
  btn.appendChild(rip);
  rip.addEventListener('animationend', () => rip.remove());
});

// ---- Now Playing (tela cheia) ----
let npVizRAF = null;

function openNowPlaying() {
  if (!current) return;
  if (blockedDuringLyricsEdit()) return;
  $('nowPlaying').classList.remove('hidden', 'closing');
  syncShuffleBtn(); syncRepeatBtn(); updatePlayButton(); updatePlayerMeta();
  $('npVol').value = String(audio.volume);
  rangeFill($('npSeek')); rangeFill($('npVol'));
  syncNpViz();
  if ($('nowPlaying').classList.contains('lyrics-mode')) { npLastCenter = null; npLyricCurTop = null; updateKaraoke(audio.currentTime); }
  updateChordsBtn();
  syncLyricScroll();
  npScheduleIdle(); // começa a contar para o modo imersivo
}
// Abre o modo imersivo já em karaokê para a faixa de demonstração — concentra o
// "uau" (ambiente colorido + letra sincronizada) num clique, sem o usuário caçar botões.
// Pequeno atraso deixa a onda de cor do card aparecer antes do imersivo deslizar.
function revealDemoImmersive() {
  setTimeout(() => {
    if (!current || !isDemoTrack(current)) return; // trocou de faixa nesse meio-tempo
    openNowPlaying();
    const np = $('nowPlaying');
    if (!np.classList.contains('lyrics-mode')) {
      np.classList.add('lyrics-mode');
      $('npLyricsBtn').classList.add('active');
      npShowChords = false; // entra no karaokê sem acordes
      renderNpLyrics(); npLastCenter = null; npLyricCurTop = null; updateKaraoke(audio.currentTime);
      updateChordsBtn();
      syncLyricScroll();
    }
  }, 260);
}
function closeNowPlaying() {
  closeViewAnimated($('nowPlaying'));
  hideNpPanels(); // EQ/fila imersivos não sobrevivem fora da NP
  stopNpViz();
  { const ly = litLyricsEl(); if (ly) ly.active = false; } // para o rAF da ilha Lit ao fechar
  npStopIdle();
  if (npIsFullscreen) toggleNpFullscreen(); // sai da tela cheia ao recolher
}
function npOpen() { return !$('nowPlaying').classList.contains('hidden'); }

// Editor de letra aberto? Bloqueia ações do mini-player que conflitam com a edição.
function lyricsEditorOpen() {
  return !!(_litLyricsEditor && _litLyricsEditor.isOpen());
}
function blockedDuringLyricsEdit() {
  if (lyricsEditorOpen()) {
    toast(t('lyrics.toast.finishEdit'), '');
    return true;
  }
  return false;
}

// ---- Modo imersivo ocioso: sem mouse, os controles somem com fade ----
const NP_IDLE_MS = 3200;
let npIdleTimer = null;
function npScheduleIdle() {
  clearTimeout(npIdleTimer);
  // com um painel (EQ/fila) aberto não entra em imersão: o usuário está interagindo
  npIdleTimer = setTimeout(() => { if (npOpen() && !npPanelOpen()) $('nowPlaying').classList.add('idle'); }, NP_IDLE_MS);
}
function npStopIdle() {
  clearTimeout(npIdleTimer);
  $('nowPlaying').classList.remove('idle');
}
function npWake() {            // movimento/entrada do mouse → reaparece e rearma o timer
  if (!npOpen()) return;
  $('nowPlaying').classList.remove('idle');
  npScheduleIdle();
}
// movimento do mouse acorda os controles
document.addEventListener('mousemove', npWake);
// mouse saiu da janela do app (ou a janela perdeu o foco) → entra em imersão na hora
function npSleepNow() { if (npOpen() && !npPanelOpen()) { clearTimeout(npIdleTimer); $('nowPlaying').classList.add('idle'); } }
document.documentElement.addEventListener('mouseleave', npSleepNow);
document.documentElement.addEventListener('mouseenter', npWake);
window.addEventListener('blur', npSleepNow);
window.addEventListener('focus', npWake);

// ---- Tela cheia (imersão máxima) ----
let npIsFullscreen = false;
async function toggleNpFullscreen() {
  npIsFullscreen = await window.api.toggleFullscreen();
  $('nowPlaying').classList.toggle('np-fs', npIsFullscreen);
  $('npFullscreen').innerHTML = npIsFullscreen ? ICONS.minimize : ICONS.maximize;
  $('npFullscreen').title = npIsFullscreen ? t('player.exitFullscreen') : t('player.fullscreen');
  setTimeout(() => { if (npOpen()) sizeNpViz(); }, 120); // recalcula a superfície após o resize
}
$('npFullscreen').addEventListener('click', toggleNpFullscreen);

$('playerId').addEventListener('click', openNowPlaying);
$('npCollapse').addEventListener('click', closeNowPlaying);
$('npPlay').addEventListener('click', togglePlay);
$('npPrev').addEventListener('click', playPrev);
$('npNext').addEventListener('click', playNext);
$('npShuffle').addEventListener('click', toggleShuffle);
$('npRepeat').addEventListener('click', cycleRepeat);
$('npSeek').addEventListener('input', () => seekTo(parseInt($('npSeek').value, 10)));
$('npVol').addEventListener('input', () => setVolume(parseFloat($('npVol').value)));
// painéis imersivos: EQ e fila abrem DENTRO da Now Playing (vidro sobre o ambiente)
function npPanelOpen() {
  return ['eqPanel', 'queuePanel'].some((id) => {
    const p = $(id);
    return p.classList.contains('np-mode') && !p.classList.contains('hidden');
  });
}
function hideNpPanels() {
  for (const id of ['eqPanel', 'queuePanel']) {
    $(id).classList.add('hidden');
    $(id).classList.remove('np-mode');
  }
  if (npOpen()) npScheduleIdle(); // volta a contar para o modo imersivo
}
$('npQueueBtn').addEventListener('click', () => {
  const p = $('queuePanel');
  const show = p.classList.contains('hidden');
  hideNpPanels();
  if (show) {
    p.classList.remove('hidden', 'closing');
    p.classList.add('np-mode');
    renderQueue();
  }
});
$('npEqBtn').addEventListener('click', () => {
  const p = $('eqPanel');
  const show = p.classList.contains('hidden');
  hideNpPanels();
  if (show) {
    p.classList.remove('hidden', 'closing');
    p.classList.add('np-mode');
    ensureLitEq(); syncLitEq();
    renderEqPresetOptions();
  }
});

// ---- Visualizador circular da Now Playing ----
// o canvas é uma superfície generosa; o raio do anel é calculado pelo tamanho da capa
function sizeNpViz() {
  const cv = $('npViz');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const css = Math.min(window.innerHeight * 0.92, window.innerWidth * 0.95);
  cv.style.width = css + 'px'; cv.style.height = css + 'px';
  cv.width = Math.round(css * dpr); cv.height = Math.round(css * dpr);
}
function drawNpViz() {
  const cv = $('npViz');
  if (!cv || !analyser || !npOpen()) { npVizRAF = null; return; }
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height, cx = w / 2, cy = h / 2;
  ctx.clearRect(0, 0, w, h);
  analyser.getByteFrequencyData(freqData);

  // o anel acompanha o TAMANHO ATUAL DA CAPA (inclui o zoom do modo ocioso e a tela cheia)
  const coverRect = $('npCover').getBoundingClientRect();
  const cvRect = cv.getBoundingClientRect();
  const pxScale = cvRect.width ? (w / cvRect.width) : 1; // device px por css px
  const coverR = Math.max(40, (coverRect.width / 2) * pxScale);
  const baseR = coverR * 1.06;     // começa logo após a borda da capa
  const maxLen = coverR * 0.62;    // barras crescem ~60% do raio da capa (um pouco além)

  const bins = freqData.length;
  const bars = 84;
  npCurPal = lerpPal(npCurPal, barTargetPal, 0.09); // transição suave ao trocar de música
  const colors = deriveBarColors(npCurPal);
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2, coverR * 0.03);
  ctx.shadowBlur = coverR * 0.08;
  for (let i = 0; i < bars; i++) {
    // espelha o espectro nos dois lados para um anel simétrico
    const half = i < bars / 2 ? i : (bars - 1 - i);
    const idx = Math.floor((half / (bars / 2)) * bins * 0.8);
    const v = (freqData[idx] || 0) / 255;
    const len = coverR * 0.04 + v * maxLen;
    const ang = (i / bars) * Math.PI * 2 - Math.PI / 2;
    const x1 = cx + Math.cos(ang) * baseR, y1 = cy + Math.sin(ang) * baseR;
    const x2 = cx + Math.cos(ang) * (baseR + len), y2 = cy + Math.sin(ang) * (baseR + len);
    const grad = ctx.createLinearGradient(x1, y1, x2, y2);
    grad.addColorStop(0, colors.bottom);
    grad.addColorStop(1, colors.top);
    ctx.strokeStyle = grad;
    ctx.shadowColor = colors.top;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  npVizRAF = requestAnimationFrame(drawNpViz);
}
function startNpViz() {
  ensureAnalyser();
  // sempre re-injeta (cobre o early-return do ensureAnalyser quando o analyser já existia)
  if (_litViz) { _litViz.analyser = analyser; _litViz.freqData = freqData; _litViz.active = true; return; }
  if (npVizRAF) return;
  sizeNpViz();
  npVizRAF = requestAnimationFrame(drawNpViz);
}
function stopNpViz() {
  if (_litViz) _litViz.active = false;
  if (npVizRAF) { cancelAnimationFrame(npVizRAF); npVizRAF = null; }
}
// liga/desliga o anel conforme estado de reprodução enquanto a NP está aberta
function syncNpViz() {
  if (!npOpen()) { stopNpViz(); return; }
  if (isPlaying) startNpViz(); else stopNpViz();
}

// ====================== Letra / Karaokê ======================
const KARAOKE_GAP_MIN = 3; // intro (s): se a 1ª linha demora mais que isso, mostra os 3 pontos
let npLyricsLines = null;   // [{ t, text }] quando sincronizada; senão null
let npChordsLines = [];     // [{ t, text }] acordes sincronizados (timeline própria)
let npLyricSlots = 5;       // linhas visíveis na janela do karaokê (6 quando há acordes)
let npShowChords = false;       // acordes começam OCULTOS; usuário ativa no botão (só faixas com acordes)
let advancedEdit = false;       // Settings: habilita edição inline de acordes no karaokê
let npChordsDirty = false;      // há edições de acordes não salvas (botão vira disquete)
let npSelChordEl = null;        // acorde selecionado (setas/Del)
let npChordHintTimer = null;    // timer p/ esconder o hint de timestamp
let npChordAccent = [150, 130, 255]; // cor dos acordes (destaque da capa, contrasta no escuro)
let npLyricsPlain = '';     // letra em texto puro (sem sincronia)
let npLyricsPath = null;    // arquivo cujas letras estão carregadas
let npLastCenter = null;
// âncoras de tempo→posição p/ rolagem contínua: [{ t, el }] (linhas + interlúdios)
let npLyricAnchors = [];
let npLyricTrack = null;    // zerado pela ilha Lit (renderNpLyricsLit); motor legado removido


// carrega a letra da faixa atual (lê a tag) e prepara o karaokê
async function loadCurrentLyrics(filePath) {
  if (!filePath) { npLyricsLines = null; npChordsLines = []; npLyricsPlain = ''; npLyricsPath = null; renderNpLyrics(); return; }
  if (npLyricsPath === filePath) return;
  npLyricsPath = filePath;
  let lyr = '', chordsRaw = '';
  try { const tags = await window.api.readTags(filePath); lyr = (tags && tags.lyrics) || ''; chordsRaw = (tags && tags.chords) || ''; } catch { /* sem letra */ }
  if (npLyricsPath !== filePath) return; // trocou de faixa enquanto lia
  if (isSyncedLyrics(lyr)) { npLyricsLines = parseLrc(lyr); npLyricsPlain = ''; }
  else { npLyricsLines = null; npLyricsPlain = lyr; }
  npChordsLines = parseLrc(chordsRaw) || [];
  npChordsDirty = false; npSelChordEl = null; // estado de edição zera ao trocar de faixa
  renderNpLyrics();
}

// ====================== Ilha Lit (Fase 0): karaokê de acordes ======================
// Prova da arquitetura por ilhas (FRONTEND-MIGRATION.md §0). COEXISTE com o karaokê
// legado — a remoção do antigo é Fase E, só após paridade. Ativa apenas no caminho
// BUNDLADO (electron-vite dev/build/prod): sob `electron .` o renderer roda sem bundler,
// o import dinâmico de 'lit' falha → cai no catch → o legado segue sozinho, sem regressão.
// As ilhas já foram registradas pelo import estático no topo do arquivo. _litReady é só
// um gancho resolvido p/ rodar o setup global (app-root/serviços) como microtask após o
// eval do módulo (DOM já parseado), antes do DOMContentLoaded.
const _litReady = Promise.resolve(true);

// Toast via ilha Lit: monta UM <syn-app-root> global (provê os serviços) com <syn-toast> dentro.
// O toast() encaminha pro ToastService da ilha.
let _litToast = null;
let _litPlayer = null; // facade do player (Fase D): o renderer sincroniza estado aqui
let _litViz = null;    // visualizer Lit (Fase E): recebe analyser/freqData/coverEl/palette/active
_litReady.then((m) => {
  if (!m || !customElements.get('syn-toast')) return;
  try {
    const root = document.createElement('syn-app-root');
    root.appendChild(document.createElement('syn-toast'));
    document.body.appendChild(root);
    _litToast = (root.services && root.services.toast) || null;
    // PlayerService como fonte única de estado: liga o <audio> real + estado inicial.
    _litPlayer = (root.services && root.services.player) || null;
    if (_litPlayer) {
      _litPlayer.audio = audio;
      _litPlayer.setState({ volume: audio.volume, shuffle, repeatMode });
      // transporte: a facade delega às funções existentes do renderer
      _litPlayer.controls = {
        toggle: togglePlay, next: playNext, prev: playPrev,
        shuffle: toggleShuffle, repeat: cycleRepeat,
        seek: seekTo, setVolume,
        openNowPlaying, toggleEq: toggleEqPanel, toggleQueue: toggleQueuePanel, closePlayer: closePlayerAction,
      };
      // monta o mini-player Lit NO LUGAR do #player legado (vira o próprio #player)
      if (customElements.get('syn-mini-player')) {
        const legacy = document.getElementById('player');
        if (legacy && legacy.tagName !== 'SYN-MINI-PLAYER') {
          const mp = document.createElement('syn-mini-player');
          mp.id = 'player';
          mp.className = legacy.className; // preserva 'player hidden'
          mp.player = _litPlayer; mp.t = t;
          legacy.replaceWith(mp);
          if (current) _litPlayer.setState({ title: current.title || '', artist: current.artist || '', current });
        }
      }
    }
    // visualizer Lit (Fase E): substitui o <canvas id=npViz> pela ilha (mesma classe .np-viz)
    if (customElements.get('syn-visualizer')) {
      const oldViz = document.getElementById('npViz');
      if (oldViz && oldViz.tagName === 'CANVAS') {
        if (npVizRAF) { cancelAnimationFrame(npVizRAF); npVizRAF = null; } // para o loop legado antes de trocar o canvas
        const v = document.createElement('syn-visualizer');
        v.coverEl = document.getElementById('npCover');
        if (analyser) { v.analyser = analyser; v.freqData = freqData; } // se já criado
        v.palette = barTargetPal;
        oldViz.replaceWith(v);
        _litViz = v;
        if (typeof npOpen === 'function' && npOpen() && isPlaying) v.active = true; // já tocando c/ NP aberta
      }
    }
    // editor de detalhes Lit (Fase E, última ilha): substitui o INTERIOR legado de #editor
    // pela ilha imersiva (display:contents, mesmos IDs). A cola do editor (openEditor/
    // saveDetails/pipeline de capa/IA/letra) segue valendo sem reescrita; os cliques entram
    // pelo roteador delegado do #editorBackdrop. Sob `electron .` (sem ilha) o markup legado fica.
    if (customElements.get('syn-track-editor')) {
      const sec = document.getElementById('editor');
      if (sec && !sec.querySelector('syn-track-editor')) {
        sec.innerHTML = '';
        const te = document.createElement('syn-track-editor');
        te.t = t;
        sec.appendChild(te);
      }
    }
  } catch { _litToast = null; }
});

// Recuo lateral (px) da faixa útil de acordes: garante que acordes em f=0 e f=1 fiquem
// visíveis (sem clipping) SEM clampar a posição — o que quebraria a coincidência
// barra↔acorde. Acorde e barra usam EXATAMENTE o mesmo mapa, então a barra encosta no
// acorde no instante c.t (independente de `end`). chordX(f) = inset + f·(W − 2·inset).
const CHORD_INSET = 28;
const CHORD_GLOW_DECAY = 1.6; // s: tempo até o acorde voltar ao estado dim após ser alcançado
function chordSpanFromFraction(f) {
  return `calc(${CHORD_INSET}px + ${f} * (100% - ${2 * CHORD_INSET}px))`;
}

// Cor de destaque dos acordes a partir da paleta da capa: mantém o MATIZ da capa, força
// saturação alta e luminosidade ~0.66 → sempre claro o bastante p/ contrastar no fundo
// escuro e claramente distinta do branco da letra. Capa acinzentada → roxo padrão do app.
function chordAccentRGB(pal) {
  if (!pal) return [150, 130, 255];
  const { h, s } = rgbToHsl(pal.r, pal.g, pal.b);
  if (s < 0.12) return [150, 130, 255];
  return hslToRgb(h, Math.min(1, Math.max(0.55, s + 0.10)), 0.66);
}

// Constrói uma linha de acordes posicionados horizontalmente pelo tempo dentro de
// [start, end]. A varredura (underline) e o ponto-cabeça ficam na BASE da linha — não
// cruzam o texto do acorde. Devolve { row, sweepEl, headEl, chords:[{t,el}] }.

const DISK_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>';

// Estado do botão de acordes: ESCONDIDO quando a faixa não tem acordes; visível mas
// DESABILITADO fora do modo karaokê; "ativo" quando exibindo. Com edições não salvas
// faz MORPH para disquete (salvar).
function updateChordsBtn() {
  const btn = $('npChordsBtn');
  if (!btn) return;
  const trackHasChords = (npChordsLines || []).some((c) => c.text);
  const karaoke = $('nowPlaying').classList.contains('lyrics-mode');
  if (npChordsDirty) {
    btn.classList.remove('hidden', 'disabled');
    btn.disabled = false;
    btn.classList.add('active', 'is-save');
    btn.innerHTML = DISK_ICON;
    btn.title = t('common.save');
  } else {
    btn.classList.toggle('hidden', !trackHasChords);
    btn.disabled = !karaoke;
    btn.classList.toggle('disabled', !karaoke);
    btn.classList.toggle('active', trackHasChords && karaoke && npShowChords);
    btn.classList.remove('is-save');
    btn.innerHTML = LE_ICON_CLEF;
    btn.title = t('player.chords');
  }
}

// ---- Karaokê via ilha Lit (<syn-lyrics>) ----------------------------------------------
// COEXISTE com o motor legado abaixo (paridade, sem regressão). Usa a ilha quando ela está
// registrada (caminho bundlado) E não está no modo de EDIÇÃO inline de acordes — a edição
// (advancedEdit) depende da camada de gestos sobre os .np-chord legados, cuja migração é um
// sub-passo posterior; nesse modo cai no legado. <syn-lyrics> vive DENTRO do #npLyrics e
// reusa toda a CSS .np-lyrics-* (light-DOM); o renderer só lhe entrega o estado (props down).
function useLitLyrics() { return !!customElements.get('syn-lyrics'); }
function litLyricsEl() { const box = $('npLyrics'); return box ? box.querySelector(':scope > syn-lyrics') : null; }
// liga/desliga o rAF da ilha conforme o karaokê está visível (NP aberta + lyrics-mode)
function syncLitLyrics() { const ly = litLyricsEl(); if (ly) ly.active = npOpen() && $('nowPlaying').classList.contains('lyrics-mode'); }

function renderNpLyricsLit(box) {
  const synced = !!(npLyricsLines && npLyricsLines.length);
  const allChords = (npChordsLines || []).filter((c) => c.text);
  const trackHasChords = allChords.length > 0;
  const hasChords = trackHasChords && npShowChords;
  const editMode = advancedEdit && hasChords; // edição inline de acordes
  updateChordsBtn();
  npLyricSlots = hasChords ? 6 : 5;
  const showTrack = synced || hasChords;
  box.classList.toggle('synced', showTrack);
  box.classList.toggle('chords-on', hasChords);
  box.classList.toggle('edit-mode', editMode);
  $('nowPlaying').classList.toggle('np-synced', showTrack);
  npChordAccent = chordAccentRGB(barTargetPal);
  box.style.setProperty('--chord-accent', npChordAccent.join(','));
  // motor legado inerte: sem âncoras, updateKaraoke/lyricFrame/syncLyricScroll viram no-op
  npLyricAnchors = []; npLyricTrack = null; npLastCenter = null; npSelChordEl = null;

  let ly = box.querySelector(':scope > syn-lyrics');
  if (!ly) {
    box.innerHTML = ''; ly = document.createElement('syn-lyrics'); box.appendChild(ly);
    // editor inline: a ilha muta npChordsLines (mesma ref) e avisa → marca "sujo" (botão salvar)
    ly.addEventListener('syn:chords:change', () => markChordsDirty());
  }
  ly.t = t;
  ly.player = _litPlayer;                       // facade por propriedade (fora do app-root)
  ly.accent = npChordAccent.join(',');
  ly.synced = npLyricsLines;
  ly.chordsData = npChordsLines || [];          // MESMA ref do estado → o save legado a lê
  ly.showChords = npShowChords;
  ly.plain = npLyricsPlain || '';
  ly.editMode = editMode;
  ly.active = npOpen() && $('nowPlaying').classList.contains('lyrics-mode');
}

// Karaokê = ilha Lit <syn-lyrics>; o renderer só lhe entrega o estado (props down).
function renderNpLyrics() {
  const box = $('npLyrics');
  if (box) renderNpLyricsLit(box);
}

// Compat: ainda chamada em timeupdate/clique/abertura. A ilha Lit tem rAF próprio
// (MediaTimeController) → no-op (motor de scroll legado removido na Fase F).
function updateKaraoke() {}

// posição animada do scroll legado — só a var sobrevive (zerada por callers compartilhados);
// a animação real é da ilha Lit.
let npLyricCurTop = null;

// (des)ativa o rAF da ilha Lit conforme o karaokê fica visível/oculto.
function syncLyricScroll() {
  syncLitLyrics();
}

$('npLyricsBtn').addEventListener('click', () => {
  const np = $('nowPlaying');
  const on = np.classList.toggle('lyrics-mode');
  $('npLyricsBtn').classList.toggle('active', on);
  if (on) { npShowChords = false; renderNpLyrics(); npLastCenter = null; npLyricCurTop = null; updateKaraoke(audio.currentTime); } // entra no karaokê sempre sem acordes
  updateChordsBtn(); // habilita/desabilita o botão de acordes conforme o modo karaokê
  syncLyricScroll();
});

// botão de acordes: quando há edições (disquete) → salva; senão alterna exibição
$('npChordsBtn').addEventListener('click', () => {
  if (npChordsDirty) { saveChordsInline(); return; }
  npShowChords = !npShowChords;
  renderNpLyrics();
  npLastCenter = null; npLyricCurTop = null; updateKaraoke(audio.currentTime);
});

// ============== Edição inline de acordes no karaokê (modo edição avançada) ==============
function markChordsDirty() { if (!npChordsDirty) { npChordsDirty = true; updateChordsBtn(); } }
function msStamp(tSec) {
  const s = Math.max(0, tSec);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(Math.floor(s % 60)).padStart(2, '0');
  const ms = String(Math.round((s - Math.floor(s)) * 1000)).padStart(3, '0');
  return `${mm}:${ss}.${ms}`;
}

async function saveChordsInline() {
  if (!current) return;
  const lrc = (npChordsLines || [])
    .filter((c) => c.text && c.text.trim())
    .slice().sort((a, b) => a.t - b.t)
    .map((c) => `[${msStamp(c.t)}]${c.text.trim()}`)
    .join('\n');
  audioReloading = true; // o arquivo será reescrito sob o stream
  try {
    const res = await window.api.chordsSet(current.filePath, lrc);
    if (res && res.error) { toast(res.error, 'error'); audioReloading = false; return; }
  } catch (err) {
    toast(String((err && err.message) || err), 'error'); audioReloading = false; return;
  }
  npChordsDirty = false; npSelChordEl = null;
  npChordsLines = parseLrc(lrc) || []; // estado limpo a partir do que foi salvo
  renderNpLyrics();
  reloadCurrentAudio();   // offsets do arquivo mudaram
  updateChordsBtn();      // disquete → clave
  toast(t('editor.saved'), 'success');
}


// ---- Fila (painel) ----
function toggleQueuePanel() {
  $('eqPanel').classList.add('hidden'); // fila e EQ não coexistem
  const p = $('queuePanel');
  p.classList.remove('np-mode'); // aberto pelo mini-player usa o visual padrão
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) renderQueue();
}
$('queueBtn').addEventListener('click', toggleQueuePanel);
$('queueClose').addEventListener('click', () => { $('queuePanel').classList.add('hidden'); $('queuePanel').classList.remove('np-mode'); });

let queueDragFrom = -1;
function renderQueue() {
  if ($('queuePanel').classList.contains('hidden')) return;
  const list = $('queueList');
  list.innerHTML = '';
  queue.forEach((s, i) => {
    // ilha Lit syn-queue-item: dirigida por VM; intents → orquestração existente (closure i)
    const item = document.createElement('syn-queue-item');
    item.t = t;
    item.vm = {
      path: s.filePath,
      title: s.title || (s.fileName || '').replace(/\.mp3$/i, ''),
      artist: s.artist || '',
      src: coverUrl(s),
      coverKnown: coverState.get(s.filePath),
      current: i === queueIndex,
    };
    item.addEventListener('syn:queue:jump', () => playAt(i));
    item.addEventListener('syn:queue:remove', () => removeFromQueue(i));
    item.addEventListener('syn:queue:cover', () => coverState.set(s.filePath, false));

    // reordenação por arraste
    item.draggable = true;
    item.addEventListener('dragstart', () => { queueDragFrom = i; item.classList.add('dragging'); });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      list.querySelectorAll('.queue-item.drop-target').forEach((el) => el.classList.remove('drop-target'));
      queueDragFrom = -1;
    });
    item.addEventListener('dragover', (e) => { e.preventDefault(); item.classList.add('drop-target'); });
    item.addEventListener('dragleave', () => item.classList.remove('drop-target'));
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drop-target');
      if (queueDragFrom >= 0 && queueDragFrom !== i) reorderQueue(queueDragFrom, i);
    });

    list.appendChild(item);
  });
}

// ---- Atalhos de teclado ----
document.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

  // Esc: fecha o overlay/painel do topo (tela cheia → Now Playing → modais → painéis)
  if (e.key === 'Escape') {
    const vis = (id) => !$(id).classList.contains('hidden');
    if (npIsFullscreen) { e.preventDefault(); toggleNpFullscreen(); return; }
    if (npOpen() && npPanelOpen()) { e.preventDefault(); hideNpPanels(); return; }
    if (npOpen() && $('nowPlaying').classList.contains('lyrics-mode')) {
      e.preventDefault(); $('nowPlaying').classList.remove('lyrics-mode'); $('npLyricsBtn').classList.remove('active'); syncLyricScroll(); return;
    }
    if (npOpen()) { e.preventDefault(); closeNowPlaying(); return; }
    if (vis('cropModal')) { closeCropper(); return; }
    if (vis('deleteModal')) { closeDeleteModal(); return; }
    if (vis('editorBackdrop')) {
      // em edição volta para a visualização; na visualização, fecha
      if ($('editor').classList.contains('edit-mode')) {
        $('editor').classList.remove('edit-mode'); $('editor').classList.add('view-mode'); renderEditorView();
      } else hideEditor();
      return;
    }
    if (vis('devicesModal')) { closeDevices(); return; }
    if (vis('settingsModal')) { closeViewAnimated($('settingsModal')); return; }
    if (!$('eqPanel').classList.contains('hidden')) { $('eqPanel').classList.add('hidden'); return; }
    if (!$('queuePanel').classList.contains('hidden')) { $('queuePanel').classList.add('hidden'); return; }
    if (vis('playlistPage')) { closePlaylistPage(); openPlaylistsView(); return; }
    if (vis('playlistsView')) { closePlaylistsView(); return; }
    if (vis('artistPage')) { closeArtistPage(); return; }
    if ($('addBar').classList.contains('open')) { $('ytUrl').value = ''; closeAdd(); return; }
    return;
  }

  if (typing) return;
  const editorOpen = !$('editorBackdrop').classList.contains('hidden');
  if (editorOpen) return;

  // ←/→: faixa anterior/próxima (com a Now Playing aberta)
  if (npOpen() && current) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); playPrev(); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); playNext(); return; }
  }

  // Espaço: tocar/pausar
  if (e.code === 'Space') {
    if (!current && !visibleList.length) return;
    e.preventDefault();
    togglePlay();
  }
});

// tira o foco dos botões do player/Now Playing após o clique,
// para o Espaço não reativar o botão focado (apenas tocar/pausar)
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('.pl-btn, .np-btn');
  if (b) b.blur();
});

// reajusta o anel do espectro ao redimensionar a janela
window.addEventListener('resize', () => { if (npOpen()) sizeNpViz(); });

// volume inicial
(function initVolume() {
  let v = 1;
  try { const s = localStorage.getItem('player.volume'); if (s != null) v = parseFloat(s); } catch { /* ok */ }
  if (!isFinite(v)) v = 1;
  audio.volume = v;
  { const e = $('vol'); if (e) { e.value = String(v); rangeFill(e); } }
  $('npVol').value = String(v);
  rangeFill($('npVol'));
})();

applyPlayerIcons();

// ====================== Equalizador ======================
// nomes via chave de tradução (resolvidos na hora de renderizar)


// aplica os ganhos atuais aos filtros (0 quando o EQ está desligado = bypass)
function applyEq() {
  if (!eqFilters) return;
  eqFilters.forEach((flt, i) => { flt.gain.value = eqEnabled ? (eqGains[i] || 0) : 0; });
}

function updateEqBtn() {
  const on = eqEnabled && eqGains.some((g) => g !== 0);
  $('eqBtn').classList.toggle('active', on);
  $('npEqBtn').classList.toggle('active', on);
}

let eqPersistTimer = null;
function persistEqState() {
  updateEqBtn();
  clearTimeout(eqPersistTimer);
  eqPersistTimer = setTimeout(() => {
    window.api.setConfig({ eq: { enabled: eqEnabled, gains: eqGains } });
  }, 300);
}

// Ilha Lit do EQ: <syn-eq> (bandas + toggle + zerar) substitui #eqBands/#eqEnabled/#eqFlat.
// Os presets/save seguem legados (o componente não os cobre). Eventos fiam no estado/Web
// Audio existente (eqGains/applyEq/persistEqState).
function ensureLitEq() {
  if (_litEq) return;
  const box = $('eqBands');
  if (!box) return;
  box.innerHTML = '';
  box.style.display = 'block'; // .eq-bands legado é flex → o syn-eq (item único) encolheria; block faz preencher
  // modo `bare`: só as 6 bandas. Título/toggle/zerar/presets ficam no painel legado
  // (evita header/controles duplicados → enquadramento limpo).
  const eq = document.createElement('syn-eq');
  eq.bare = true;
  eq.addEventListener('syn:eq:change', (e) => {
    eqGains = e.detail.gains.slice();
    // auto-liga ao mexer numa banda p/ valor != 0 (espelha o legado)
    if (!eqEnabled && eqGains.some((g) => g !== 0)) { eqEnabled = true; $('eqEnabled').checked = true; applyEq(); }
    applyEq();
    persistEqState();
  });
  box.appendChild(eq);
  _litEq = eq;
}
function syncLitEq() { if (_litEq) { _litEq.gains = eqGains.slice(); _litEq.enabled = eqEnabled; } }

function renderEqPresetOptions() {
  const sel = $('eqPreset');
  sel.innerHTML = '';
  const def = document.createElement('option');
  def.value = ''; def.textContent = t('eq.presets');
  sel.appendChild(def);
  const og1 = document.createElement('optgroup');
  og1.label = t('eq.builtinGroup');
  EQ_BUILTINS.forEach((p, i) => {
    const o = document.createElement('option'); o.value = 'b' + i; o.textContent = t(p.nameKey); og1.appendChild(o);
  });
  sel.appendChild(og1);
  if (eqPresets.length) {
    const og2 = document.createElement('optgroup');
    og2.label = t('eq.myPresetsGroup');
    eqPresets.forEach((p, i) => {
      const o = document.createElement('option'); o.value = 'u' + i; o.textContent = p.name; og2.appendChild(o);
    });
    sel.appendChild(og2);
  }
}

function loadEqPreset(gains, enable) {
  eqGains = gains.slice(0, 6).map((n) => Math.max(-12, Math.min(12, parseInt(n, 10) || 0)));
  while (eqGains.length < 6) eqGains.push(0);
  if (enable) { eqEnabled = true; $('eqEnabled').checked = true; }
  applyEq();
  syncLitEq();
  persistEqState();
}

function toggleEqPanel() {
  if (blockedDuringLyricsEdit()) return;
  const p = $('eqPanel');
  p.classList.remove('np-mode'); // aberto pelo mini-player usa o visual padrão
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) {
    $('queuePanel').classList.add('hidden');
    ensureLitEq(); syncLitEq();
    renderEqPresetOptions();
  }
}
$('eqBtn').addEventListener('click', toggleEqPanel);
$('eqClose').addEventListener('click', () => { $('eqPanel').classList.add('hidden'); $('eqPanel').classList.remove('np-mode'); });
$('eqEnabled').addEventListener('change', () => {
  eqEnabled = $('eqEnabled').checked;
  applyEq();
  persistEqState();
});
$('eqFlat').addEventListener('click', () => loadEqPreset([0, 0, 0, 0, 0, 0], false));
$('eqPreset').addEventListener('change', () => {
  const v = $('eqPreset').value;
  if (!v) return;
  const p = v[0] === 'b' ? EQ_BUILTINS[+v.slice(1)] : eqPresets[+v.slice(1)];
  if (p) {
    loadEqPreset(p.gains, true);
    $('eqName').value = p.builtin ? '' : p.name;
  }
});
$('eqSave').addEventListener('click', async () => {
  const name = $('eqName').value.trim();
  if (!name) { toast(t('eq.nameRequired'), 'error'); return; }
  const idx = eqPresets.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
  const entry = { name, gains: eqGains.slice() };
  if (idx >= 0) eqPresets[idx] = entry; else eqPresets.push(entry);
  await window.api.setConfig({ eqPresets });
  renderEqPresetOptions();
  toast(t('eq.presetSaved'), 'success');
});
$('eqDelete').addEventListener('click', async () => {
  const v = $('eqPreset').value;
  if (v[0] !== 'u') { toast(t('eq.selectOwnPreset'), 'error'); return; }
  eqPresets.splice(+v.slice(1), 1);
  await window.api.setConfig({ eqPresets });
  renderEqPresetOptions();
  $('eqName').value = '';
  toast(t('eq.presetDeleted'), 'success');
});

async function initEq() {
  try {
    const cfg = await window.api.getConfig();
    if (cfg.eq && Array.isArray(cfg.eq.gains) && cfg.eq.gains.length === 6) {
      eqGains = cfg.eq.gains.map((n) => Math.max(-12, Math.min(12, parseInt(n, 10) || 0)));
    }
    eqEnabled = !!(cfg.eq && cfg.eq.enabled);
    if (Array.isArray(cfg.eqPresets)) {
      eqPresets = cfg.eqPresets.filter((p) => p && p.name && Array.isArray(p.gains));
    }
  } catch { /* usa padrões */ }
  $('eqEnabled').checked = eqEnabled;
  updateEqBtn();
  applyEq(); // filtros podem ainda não existir; reaplica ao criar
}

// fecha o EQ ao abrir a fila (e vice-versa já tratado no eqBtn)
$('queueBtn').addEventListener('click', () => $('eqPanel').classList.add('hidden'));

// ====================== Busca (expansível) e agrupamento ======================
function expandSearch() {
  closeAdd();
  $('searchBox').classList.add('expanded');
  $('toolbar').classList.add('searching');
  $('searchInput').focus();
}
function collapseSearch() {
  $('searchBox').classList.remove('expanded');
  $('toolbar').classList.remove('searching');
}
function clearAndCollapseSearch() {
  searchQuery = '';
  $('searchInput').value = '';
  collapseSearch();
  listEntrance = true;
  renderList();
}
$('searchBtn').addEventListener('click', expandSearch);
$('searchInput').addEventListener('input', () => {
  searchQuery = $('searchInput').value;
  listEntrance = true;
  renderList();
});
$('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.stopPropagation(); clearAndCollapseSearch(); }
});
$('searchInput').addEventListener('blur', () => {
  if (!$('searchInput').value.trim()) collapseSearch();
});
$('searchClose').addEventListener('click', clearAndCollapseSearch);
$('groupToggle').addEventListener('click', () => {
  groupBy = !groupBy;
  $('groupToggle').classList.toggle('active', groupBy);
  try { localStorage.setItem('lib.groupBy', groupBy ? '1' : '0'); } catch { /* ok */ }
  listEntrance = true;
  renderList();
});

// ---- Scrollbar customizada da listagem: fade suave, visível com o mouse na área ----
(function initLibScrollbar() {
  const contentEl = document.querySelector('.content');
  const bar = $('libScrollbar');
  if (!contentEl || !bar) return;
  const thumb = bar.querySelector('.lib-scrollbar-thumb');
  const PAD = 4;            // folga do trilho em cima/baixo
  let hideTimer = null;
  let dragging = false;
  let dragStartY = 0;
  let dragStartScroll = 0;

  const metrics = () => {
    const sh = contentEl.scrollHeight, ch = contentEl.clientHeight;
    return { sh, ch, max: sh - ch };
  };

  // reposiciona trilho e thumb conforme o scroll e o tamanho atual da área
  function update() {
    const { sh, ch, max } = metrics();
    if (max <= 1) { bar.classList.remove('visible'); return false; }
    const r = contentEl.getBoundingClientRect();
    bar.style.top = r.top + 'px';
    bar.style.height = r.height + 'px';
    const trackH = r.height - PAD * 2;
    const th = Math.max(28, (ch / sh) * trackH);
    const top = PAD + (contentEl.scrollTop / max) * (trackH - th);
    thumb.style.height = th + 'px';
    thumb.style.transform = `translateY(${top}px)`;
    return true;
  }

  function show() {
    if (!update()) return;
    bar.classList.add('visible');
    clearTimeout(hideTimer);
    if (!dragging) hideTimer = setTimeout(() => bar.classList.remove('visible'), 1200);
  }
  function hideSoon() {
    if (dragging) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => bar.classList.remove('visible'), 350);
  }

  // qualquer movimento/rolagem sobre a área da listagem mantém a barra visível
  contentEl.addEventListener('mousemove', show);
  contentEl.addEventListener('scroll', show, { passive: true });
  contentEl.addEventListener('mouseleave', hideSoon);
  bar.addEventListener('mousemove', show);
  window.addEventListener('resize', () => { if (bar.classList.contains('visible')) update(); });

  // arrastar o thumb rola a lista
  thumb.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    bar.classList.add('dragging');
    dragStartY = e.clientY;
    dragStartScroll = contentEl.scrollTop;
    thumb.setPointerCapture(e.pointerId);
  });
  thumb.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const { sh, ch, max } = metrics();
    const trackH = bar.clientHeight - PAD * 2;
    const th = Math.max(28, (ch / sh) * trackH);
    const pxToScroll = max / Math.max(1, trackH - th);
    contentEl.scrollTop = dragStartScroll + (e.clientY - dragStartY) * pxToScroll;
  });
  const endThumbDrag = () => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('dragging');
    show();
  };
  thumb.addEventListener('pointerup', endThumbDrag);
  thumb.addEventListener('pointercancel', endThumbDrag);

  // clique no trilho: salta para a posição correspondente
  bar.addEventListener('pointerdown', (e) => {
    if (e.target !== bar) return;
    const { sh, ch, max } = metrics();
    const trackH = bar.clientHeight - PAD * 2;
    const th = Math.max(28, (ch / sh) * trackH);
    const y = e.clientY - bar.getBoundingClientRect().top - PAD - th / 2;
    contentEl.scrollTop = (y / Math.max(1, trackH - th)) * max;
    show();
  });

  // roda do mouse sobre a barra rola a lista normalmente
  bar.addEventListener('wheel', (e) => { contentEl.scrollTop += e.deltaY; }, { passive: true });
})();

// restaura preferências de visualização
(function initLibPrefs() {
  try { groupBy = localStorage.getItem('lib.groupBy') === '1'; } catch { /* ok */ }
  try {
    const c = JSON.parse(localStorage.getItem('lib.collapsed') || '[]');
    if (Array.isArray(c)) collapsedArtists = new Set(c);
  } catch { /* ok */ }
  $('groupToggle').classList.toggle('active', groupBy);
})();

// ====================== Dispositivos / sincronização ======================
let lastAttachedSerial = null; // último dispositivo que disparou a notificação

// Status de loading na barra de ferramentas (sempre visível): prioriza
// downloads/enriquecimento em andamento; senão, mostra a varredura/sync do dispositivo.
let syncStatusMsg = null;
function refreshToolbarStatus() {
  const active = pendingJobs.filter((j) =>
    j.status === 'downloading' || j.status === 'enriching' || j.status === 'saving');
  let msg = null;
  if (active.length === 1) msg = active[0].statusMsg || t('jobs.processing');
  else if (active.length > 1) msg = t('jobs.nProcessing', { n: active.length });
  else if (syncStatusMsg) msg = syncStatusMsg;

  const el = $('toolbarStatus');
  if (msg) { $('toolbarStatusMsg').textContent = msg; el.classList.remove('hidden', 'closing'); }
  else el.classList.add('hidden');
}
function showScanIndicator(msg) { syncStatusMsg = msg || t('sync.scanning'); refreshToolbarStatus(); }
function hideScanIndicator() { syncStatusMsg = null; refreshToolbarStatus(); }

// ---- Central de sincronização: estado e helpers ----
const deviceStats = {};      // serial -> { pendingCount, pendingBytes }
const deviceConnInfo = {};   // serial -> { free, size, connected }

function setDevicesBusy(b) { $('devicesBtn').classList.toggle('syncing', b); }


// artistas únicos da biblioteca (chave normalizada → nome de exibição)
function libraryArtists() {
  const m = new Map();
  for (const s of songs) {
    const k = normPart(s.artist || '');
    if (!m.has(k)) m.set(k, (s.artist || '').trim() || t('library.noArtist'));
  }
  return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], t('meta.locale')));
}

// barra de capacidade do dispositivo (usado / a sincronizar / livre)
function paintCapacity(el, info, stats) {
  const size = info.size || 0, free = info.free || 0;
  const used = Math.max(0, size - free);
  const pend = stats ? (stats.pendingBytes || 0) : null;
  const usedPct = size ? (used / size) * 100 : 0;
  const pendPct = size ? (Math.min(pend || 0, free) / size) * 100 : 0;

  el.innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'cap-bar';
  const u = document.createElement('div'); u.className = 'cap-used'; u.style.width = usedPct + '%';
  const p = document.createElement('div'); p.className = 'cap-pending'; p.style.width = pendPct + '%';
  bar.append(u, p);

  const label = document.createElement('div');
  label.className = 'cap-label';
  let txt = t('devices.freeOf', { free: fmtBytes(free), size: fmtBytes(size) });
  if (pend == null) txt += t('devices.calculating');
  else if (pend > 0) txt += t('devices.missing', { bytes: fmtBytes(pend) }) +
    (stats.pendingCount ? t('devices.missingTracks', { tracks: tn('count.track', stats.pendingCount) }) : '');
  else txt += t('devices.upToDateCap');
  label.textContent = txt;
  if (pend != null && pend > free) label.classList.add('warn-text');

  el.append(bar, label);
}
function paintCapacityRow(serial) {
  const row = document.querySelector(`.device-row[data-serial="${cssEsc(serial)}"]`);
  if (!row) return;
  const cap = row.querySelector('.device-capacity');
  if (cap) paintCapacity(cap, deviceConnInfo[serial] || {}, deviceStats[serial]);
}

// progresso inline (na sheet) durante a sincronização de um dispositivo
function updateDeviceRowProgress(serial, p) {
  const row = document.querySelector(`.device-row[data-serial="${cssEsc(serial)}"]`);
  if (!row) return;
  const prog = row.querySelector('.device-progress');
  if (!prog) return;
  prog.classList.remove('hidden', 'closing');
  const bar = prog.querySelector('.dp-bar > div');
  const txt = prog.querySelector('.dp-text');
  if (p.phase === 'sync') {
    if (bar) bar.style.width = (p.percent || 0) + '%';
    if (txt) txt.textContent = p.current ? t('sync.syncingCur', { done: p.done, total: p.total, current: p.current }) : t('sync.syncing');
  } else {
    if (bar) bar.style.width = '100%';
    // ignora o texto vindo do worker (não traduzido): monta a mensagem aqui
    if (txt) txt.textContent = (p.total != null && p.done != null)
      ? t('sync.syncingN', { done: p.done, total: p.total })
      : t('sync.scanning');
  }
}
function hideDeviceRowProgress(serial) {
  const row = document.querySelector(`.device-row[data-serial="${cssEsc(serial)}"]`);
  if (row) { const prog = row.querySelector('.device-progress'); if (prog) prog.classList.add('hidden'); }
}

// recalcula o "quanto falta" de um dispositivo conectado (sem copiar nada)
async function refreshDeviceStats(serial) {
  if (syncBusy) return; // não concorre com o fluxo principal
  const info = deviceConnInfo[serial];
  if (!info || !info.connected) return;
  try {
    const scan = await window.api.deviceScan(serial);
    if (scan && !scan.error) {
      deviceStats[serial] = { pendingCount: scan.pendingCount, pendingBytes: scan.pendingBytes || 0 };
      paintCapacityRow(serial);
    }
  } finally { hideDeviceRowProgress(serial); }
}

async function persistScope(serial, scope) {
  await window.api.devicesUpdate({
    serial,
    syncScope: scope.mode === 'artists' ? { mode: 'artists', artists: scope.artists } : { mode: 'all' }
  });
}

// ---- Notificação de dispositivo conectado ----
function showDeviceNotice(info) {
  lastAttachedSerial = info.serial;
  const label = info.label || info.model || t('devices.storage');
  $('deviceNoticeSub').textContent = t('deviceNotice.subLabel', { label });
  $('deviceNotice').classList.remove('hidden', 'closing');
}
function hideDeviceNotice() { $('deviceNotice').classList.add('hidden'); }

$('deviceNotice').addEventListener('click', (e) => {
  if (e.target === $('deviceNoticeClose')) return;
  hideDeviceNotice();
  openDevices();
});
$('deviceNoticeClose').addEventListener('click', (e) => {
  e.stopPropagation();
  hideDeviceNotice();
});

// ---- Eventos de conexão/desconexão ----
window.api.onDeviceAttached(async (info) => {
  if (info.ignored) return; // dispositivo ignorado: não mostra nada
  if (info.configured && info.syncEnabled) {
    // conhecido e com sync ligada → varre e sincroniza
    await runScanAndSync(info);
  } else {
    // novo / não configurado → notifica para o usuário configurar
    showDeviceNotice(info);
  }
});

window.api.onDeviceDetached((info) => {
  if (activeDevice && activeDevice.serial === info.serial) {
    activeDevice = null;
    deviceOnlySongs = [];
    // mantém os badges com o último estado conhecido (sync.json)
    renderList();
  }
  if (lastAttachedSerial === info.serial) hideDeviceNotice();
  // atualiza a sheet se estiver aberta
  if (!$('devicesModal').classList.contains('hidden')) renderDevices();
});

window.api.onSyncProgress((p) => {
  // badge persistente no cabeçalho só durante o fluxo principal de sync
  if (syncBusy) {
    if (p.phase === 'sync') {
      showScanIndicator(p.total ? t('sync.syncingN', { done: p.done, total: p.total }) : t('sync.syncing'));
    } else {
      showScanIndicator(t('sync.scanning'));
    }
  }
  // progresso inline (com nome do arquivo) na sheet de dispositivos
  updateDeviceRowProgress(p.serial, p);
});

// ---- Fluxo: varredura → sincronização ----
// A cópia roda em um worker no processo principal (não trava a UI). Aqui apenas
// coordenamos: chamadas concorrentes são coalescidas (a última fica pendente).
let syncBusy = false;
let syncQueued = null;
async function runScanAndSync(info) {
  if (syncBusy) { syncQueued = info; return; } // já há uma sincronização em curso
  syncBusy = true;
  setDevicesBusy(true);
  activeDevice = { serial: info.serial, nickname: info.nickname, label: info.label };
  showScanIndicator(t('sync.scanning'));
  try {
    const scan = await window.api.deviceScan(info.serial);
    if (scan && scan.error) { toast(scan.error, 'error'); return; }
    if (Array.isArray(scan.syncedKeys)) syncedKeys = new Set(scan.syncedKeys);
    hasSyncContext = true;
    deviceOnlySongs = scan.deviceOnly || [];
    deviceStats[info.serial] = { pendingCount: scan.pendingCount, pendingBytes: scan.pendingBytes || 0 };
    paintCapacityRow(info.serial);
    renderList();

    showScanIndicator(scan.pendingCount ? t('sync.syncingN', { done: 0, total: scan.pendingCount }) : t('sync.syncing'));
    const res = await window.api.deviceSync(info.serial);
    if (res && res.error) { toast(res.error, 'error'); return; }
    if (res && res.queued) return; // outra sincronização assumiu; sem toast

    if (Array.isArray(res.syncedKeys)) syncedKeys = new Set(res.syncedKeys);
    deviceStats[info.serial] = { pendingCount: res.failed || 0, pendingBytes: 0 };
    paintCapacityRow(info.serial);
    renderList();

    const nick = info.nickname || info.label || t('deleteModal.deviceFallback');
    if (res.copied > 0) {
      toast(t('sync.copied', { n: res.copied, nick }), 'success');
    } else {
      toast(t('sync.upToDate', { nick }), 'success');
    }
    if (res.failed > 0) toast(t('sync.failedN', { n: res.failed }), 'error');
  } catch (err) {
    toast(t('sync.fail', { msg: (err && err.message ? err.message : err) }), 'error');
  } finally {
    syncBusy = false;
    setDevicesBusy(false);
    hideScanIndicator();
    hideDeviceRowProgress(info.serial);
    if (syncQueued) { const next = syncQueued; syncQueued = null; runScanAndSync(next); }
  }
}

// re-sincroniza em segundo plano quando a biblioteca muda e há dispositivo ativo
function maybeResync() {
  if (!activeDevice) return;
  runScanAndSync({
    serial: activeDevice.serial, nickname: activeDevice.nickname, label: activeDevice.label,
    configured: true, syncEnabled: true
  });
}

// ---- Sheet de dispositivos ----
async function openDevices() {
  showingIgnored = false;
  $('devicesModal').classList.remove('hidden', 'closing');
  await renderDevices();
}
function closeDevices() { closeViewAnimated($('devicesModal')); }

$('devicesBtn').addEventListener('click', openDevices);
$('closeDevices').addEventListener('click', closeDevices);
$('devicesModal').addEventListener('click', (e) => {
  if (e.target === $('devicesModal')) closeDevices();
});
$('toggleIgnored').addEventListener('click', () => {
  showingIgnored = !showingIgnored;
  $('toggleIgnored').textContent = showingIgnored ? t('devices.hideIgnored') : t('devices.showIgnored');
  $('ignoredList').classList.toggle('hidden', !showingIgnored);
});

// Linha de dispositivo = ilha Lit <syn-device> (light-DOM). O host vira .device-row[data-serial]
// → CSS global + helpers por-serial (capacidade/progresso) seguem valendo.
function buildDeviceEl(d) {
  deviceConnInfo[d.serial] = { free: d.free, size: d.size, connected: d.connected };
  const el = document.createElement('syn-device');
  el.device = d;
  el.stats = deviceStats[d.serial] || null;
  el.artists = libraryArtists();
  el.t = t; el.tn = tn;
  return el;
}

// Intents do syn-device → orquestração existente. Delegado no modal (eventos bubbles+composed).
let _devIntentsWired = false;
function wireDeviceIntents() {
  if (_devIntentsWired) return;
  _devIntentsWired = true;
  const modal = $('devicesModal');
  modal.addEventListener('syn:device:nick', (e) => window.api.devicesUpdate({ serial: e.detail.serial, nickname: e.detail.nickname }));
  modal.addEventListener('syn:device:sync-toggle', async (e) => {
    const { serial, enabled, connected, nickname, label } = e.detail;
    await window.api.devicesUpdate({ serial, syncEnabled: enabled });
    await renderDevices();
    if (enabled && connected) runScanAndSync({ serial, nickname, label, configured: true, syncEnabled: true });
    else if (!enabled && activeDevice && activeDevice.serial === serial) { activeDevice = null; deviceOnlySongs = []; renderList(); }
  });
  modal.addEventListener('syn:device:scope', (e) => { persistScope(e.detail.serial, e.detail.scope); refreshDeviceStats(e.detail.serial); });
  modal.addEventListener('syn:device:ignore', async (e) => { await window.api.devicesUpdate({ serial: e.detail.serial, ignored: e.detail.ignored }); await renderDevices(); });
  modal.addEventListener('syn:device:sync-now', (e) => runScanAndSync({ serial: e.detail.serial, nickname: e.detail.nickname, label: e.detail.label, configured: true, syncEnabled: true }));
}

async function renderDevices() {
  wireDeviceIntents();
  const res = await window.api.devicesList();
  const devices = (res && res.devices) || [];
  const active = devices.filter((d) => !d.ignored);
  const ignored = devices.filter((d) => d.ignored);

  const list = $('deviceList');
  list.innerHTML = '';
  // conectados primeiro, depois por apelido/rótulo
  active.sort((a, b) => (b.connected - a.connected) ||
    (a.nickname || a.label || '').localeCompare(b.nickname || b.label || '', t('meta.locale')));
  for (const d of active) list.appendChild(buildDeviceEl(d));

  $('deviceEmpty').classList.toggle('hidden', active.length > 0 || ignored.length > 0);

  const igList = $('ignoredList');
  igList.innerHTML = '';
  for (const d of ignored) igList.appendChild(buildDeviceEl(d));
  $('toggleIgnored').classList.toggle('hidden', ignored.length === 0);
  $('toggleIgnored').textContent = showingIgnored ? t('devices.hideIgnored') : t('devices.showIgnored');
  igList.classList.toggle('hidden', !showingIgnored);

  // calcula "quanto falta" p/ dispositivos conectados+sync sem dados em cache
  for (const d of active) {
    if (d.connected && d.syncEnabled && !deviceStats[d.serial]) refreshDeviceStats(d.serial);
  }
}

// Restaura o contexto de badges no início (último dispositivo configurado/conectado)
async function initSyncContext() {
  try {
    const res = await window.api.devicesList();
    const devices = (res && res.devices) || [];
    if (!devices.length) return;
    // prioriza o conectado; senão, um já configurado
    const ref = devices.find((d) => d.connected && d.configured) ||
      devices.find((d) => d.configured) || null;
    if (!ref) return;
    const st = await window.api.deviceSyncState(ref.serial);
    syncedKeys = new Set((st && st.keys) || []);
    hasSyncContext = true;
    if (ref.connected) activeDevice = { serial: ref.serial, nickname: ref.nickname, label: ref.label };
    renderList();
  } catch { /* sem contexto */ }
}

// ====================== Início ======================
// remove o splash inicial assim que a tela principal foi pintada
function dismissStartupSplash() {
  const splash = document.getElementById('startupSplash');
  if (!splash) return;
  // dois rAF garantem que o layout/paint da biblioteca já ocorreu antes do fade
  requestAnimationFrame(() => requestAnimationFrame(() => {
    splash.classList.add('fade-out');
    splash.addEventListener('transitionend', () => splash.remove(), { once: true });
    setTimeout(() => splash.remove(), 1100); // fallback caso o transitionend não dispare
  }));
}

window.addEventListener('DOMContentLoaded', async () => {
  const t0 = Date.now();

  // Failsafe de último recurso: remove o splash após 15 s em qualquer caso,
  // evitando que um travamento desconhecido deixe o app inutilizável.
  const splashFailsafe = setTimeout(() => {
    console.warn('[startup] failsafe de 15 s ativado — removendo splash forçadamente');
    dismissStartupSplash();
  }, 15000);

  try {
    // idioma primeiro: traduz a interface estática antes da primeira pintura
    console.debug('[startup] aguardando i18n…');
    await i18nReady;
    console.debug('[startup] i18n pronto em', Date.now() - t0, 'ms');
    applyStaticI18n();

    // a biblioteca é a tela inicial visível: carrega e renderiza primeiro
    console.debug('[startup] carregando biblioteca…');
    await reloadLibrary();
    console.debug('[startup] biblioteca pronta em', Date.now() - t0, 'ms');
  } finally {
    clearTimeout(splashFailsafe);
    dismissStartupSplash();
  }

  // o restante da inicialização não bloqueia a exibição da tela inicial
  Promise.all([loadPlaylists(), initSyncContext(), initEq()]).catch(() => {});
  window.api.getConfig().then((cfg) => {
    if (cfg) advancedEdit = cfg.advancedEdit === true;
    if (cfg && !cfg.apiKey) {
      setTimeout(() => toast(t('settings.configureKey'), ''), 600);
    }
  }).catch(() => {});
});

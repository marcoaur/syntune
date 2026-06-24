// ===================== Módulos puros (ESM) =====================
// Helpers sem estado, extraídos do monolito. Ver renderer/modules/*.js e AGENTS.md.
import { normPart, keyOf, normalizeText, artistInitials, fmtDb } from './modules/format.js';
import { rgbToHsl, hslToRgb, deriveBarColors, lerpPal } from './modules/color.js';
import { isSyncedLyrics, parseLrc, lrcToPlain, parseLrcTime, fmtTimestamp, parseLrcSeconds, parseLyricsToLines, serializeLines } from './modules/lrc.js';
import { LYRICS_STATUS, EQ_BANDS, EQ_BUILTINS } from './modules/constants.js';
import { ICONS } from './modules/icons.js';

// Camada Lit (ilhas + folhas): import ESTÁTICO → registra todos os custom elements
// (customElements.define) durante o eval deste módulo, ANTES do 1º render/DOMContentLoaded.
// Seguro pós-Fase F: o renderer roda SEMPRE bundlado (electron-vite), onde `import 'lit'`
// resolve. Não há mais fallback legado — os custom elements estão sempre registrados.
import './components/index.js';
// Capacidades headless (ARCHITECTURE-V2): acionáveis por qualquer um (toast-like).
import { loading, palette, menu, confirm as confirmCap } from './components/capabilities.js';
// Folha compartilhada do card de faixa (factory pura + delegação no renderer).
import { buildSongCard, configureSongCard } from './components/song/build-song-card.js';
// Store-núcleo (ARCHITECTURE-V2 Fase 3): fonte única do estado central. O renderer lê/
// escreve direto nos stores (libraryStore.songs/setSongs etc.); os mesmos singletons são
// providos via context pelo <syn-app-root> p/ os componentes consumirem.
import { libraryStore, playlistsStore, playerStore, devicesStore } from './services/core-store.js';

// Substitui o confirm() nativo (síncrono/bloqueante) pela capacidade <syn-confirm> (async).
function askConfirm(message, opts = {}) {
  return confirmCap().ask({ message, cancelLabel: t('common.cancel'), ...opts });
}

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
// `songs` vive em libraryStore (fonte única; core-store.js). Leitura: libraryStore.songs.

// Sincronização com dispositivo
// activeDevice/syncedKeys vivem em devicesStore (fonte única; core-store.js).
// Leitura: devicesStore.activeDevice / devicesStore.syncedKeys; escrita via setX.


// Player
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
// Delegam à capacidade <syn-loading> (portal no body). Wrappers finos p/ não tocar os
// ~15 call-sites de showLoading/hideLoading.
function showLoading(msg) { loading().show(msg || t('common.loading')); }
function hideLoading() { loading().hide(); }
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

// Cor-chave da capa → capacidade headless palette() (compute + cache). Delegate p/ não
// tocar os call-sites (applyPalette/ambiente/editor/playlist/artista).
function getPalette(dataUrl) { return palette().of(dataUrl); }

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

async function reloadLibrary() {
  try {
    // Timeout de 10 s: se a leitura da pasta travar (rede, pendrive removido etc.),
    // não bloqueia o startup — a biblioteca fica vazia e o splash é removido normalmente.
    const timeoutPromise = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('library:list timeout')), 10000)
    );
    const res = await Promise.race([window.api.libraryList(), timeoutPromise]);
    libraryStore.setSongs((res && res.items) || []); // fonte única → espelho `songs`
  } catch (err) {
    console.warn('[reloadLibrary]', err.message || err);
    libraryStore.setSongs([]);
  }
  if (synLibrary) synLibrary.refresh();
}

function songSubtitle(s) {
  const parts = [];
  if (s.artist) parts.push(s.artist);
  if (s.year) parts.push(s.year);
  return parts.join(' · ') || t('library.noInfo');
}


// Faixa de demonstração semeada (artista "Syntune" + álbum "Demo") — contrato com o
// asset em assets/demo/. Ao clicá-la, o app abre direto no modo imersivo + karaokê
// (o "primeiro uau"). Some quando o usuário a substitui/apaga.
function isDemoTrack(s) { return !!s && s.artist === 'Syntune' && s.album === 'Demo'; }


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


// ====================== Playlists (view <syn-playlists>) ======================
// O domínio de playlists vive na ilha <syn-playlists> (dona da grade+página, CRUD, drag,
// rename, export, sync). Estado vem dos stores; efeitos cross-subsistema chegam pelos
// intents (já wired). O renderer só injeta glue/UI e aciona pelos métodos públicos.
const synPlaylists = document.querySelector('syn-playlists');
if (synPlaylists) {
  Object.assign(synPlaylists, {
    t, tn, toast,
    closeView: (el) => closeViewAnimated(el),
    showScanIndicator, hideScanIndicator,
    getPalette, coverUrl, coverState,
  });
}
$('playlistsBtn').addEventListener('click', () => { if (synPlaylists) synPlaylists.open(); });

// O card de faixa é a folha compartilhada buildSongCard (components/song/build-song-card.js):
// factory pura dirigida por VM. As ações (play/menu/cover) sobem como intents (eventos
// bubbles) e são tratadas aqui por DELEGAÇÃO única no document — a folha não conhece o
// renderer. Injeta-se 1x t/coverUrl/coverState/songSubtitle (singletons app-global).
configureSongCard({ t, coverUrl, coverState, songSubtitle });
function wireSongCardDelegation() {
  document.addEventListener('syn:song:play', (e) => {
    const el = e.target.closest && e.target.closest('syn-song-card'); if (!el || !el._song) return;
    const s = el._song;
    if (current && current.filePath === s.filePath) togglePlay();
    else { spawnPlayBurst(el); playFromCard(s, el._queue); if (isDemoTrack(s)) revealDemoImmersive(); }
  });
  document.addEventListener('syn:song:menu', (e) => {
    const el = e.target.closest && e.target.closest('syn-song-card'); if (!el || !el._song) return;
    openSongMenu(el._song, el.querySelector('.song-menu'));
  });
  document.addEventListener('syn:song:cover', (e) => {
    const el = e.target.closest && e.target.closest('syn-song-card'); if (!el || !el._song) return;
    coverState.set(el._song.filePath, e.detail.ok);
    if (e.detail.ok) applyPalette(el, e.detail.src);
  });
}
wireSongCardDelegation();

// Intents de EFEITO cross-subsistema (ARCHITECTURE-V2): uma view emite (evento bubbles →
// document) e o renderer, dono do player/biblioteca, executa. Desacopla as views das
// funções do renderer — a view não chama playList/renderList direto, emite a intenção.
function emitIntent(name, detail) { document.dispatchEvent(new CustomEvent(name, { detail })); }
// Ilhas: biblioteca (tela principal) + adicionar/downloads. Injeção CRUZADA via thunks
// (library precisa dos cards de job do add; add precisa do collapseSearch da library).
const synLibrary = document.querySelector('syn-library');
const synAdd = document.querySelector('syn-add');
if (synAdd) Object.assign(synAdd, {
  t, toast, showScanIndicator, hideScanIndicator, makeCenterCrop,
  collapseSearch: () => synLibrary && synLibrary.collapseSearch(),
});
if (synLibrary) Object.assign(synLibrary, {
  t, tn, toast, closeView: (el) => closeViewAnimated(el),
  getPalette, coverUrl, coverState, spawnPlayBurst, refreshToolbarStatus,
  pendingCards: () => (synAdd ? synAdd.pendingCards() : []),
  hasPending: () => !!(synAdd && synAdd.hasPending()),
});
// Painel da fila (engine no renderer; injeta leitura da fila, ações por intent).
const synQueue = document.querySelector('syn-queue');
if (synQueue) Object.assign(synQueue, { t, coverUrl, coverState, getQueue: () => queue, getIndex: () => queueIndex });

function wireViewIntents() {
  document.addEventListener('syn:player:play-list', (e) => playList((e.detail && e.detail.songs) || []));
  document.addEventListener('syn:player:mark-cards', () => markPlayingCards());
  document.addEventListener('syn:library:refresh', () => { if (synLibrary) synLibrary.refresh(); });
  document.addEventListener('syn:library:reload', () => reloadLibrary());
  document.addEventListener('syn:devices:resync', () => maybeResync());
  document.addEventListener('syn:toolbar:refresh', () => refreshToolbarStatus());
  document.addEventListener('syn:add:close', () => { if (synAdd) synAdd.close(); });
  document.addEventListener('syn:queue:jump', (e) => playAt(e.detail.index));
  document.addEventListener('syn:queue:remove', (e) => removeFromQueue(e.detail.index));
  document.addEventListener('syn:queue:reorder', (e) => reorderQueue(e.detail.from, e.detail.to));
}
wireViewIntents();

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
    devicesStore.setDeviceOnlySongs(devicesStore.deviceOnlySongs.filter((s) => s.filePath !== song.filePath));
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
  if (!(await askConfirm(t('lyrics.confirm.remove'), { danger: true, confirmLabel: t('common.delete') }))) return;
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
    const updated = libraryStore.songs.find((x) => x.filePath === currentFilePath);
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
  const s = libraryStore.songs.find((x) => x.filePath === currentFilePath)
    || devicesStore.deviceOnlySongs.find((x) => x.filePath === currentFilePath)
    || { filePath: currentFilePath, fileName: $('fileName').textContent, title: $('title').value, artist: $('artist').value };
  hideEditor();
  openDeleteModal(s);
}

// ====================== Menu de opções da música (⋯) ======================
// Usa a capacidade <syn-menu> (portal/posição/fechar próprios). Itens = ações.
function openSongMenu(s, anchorEl) {
  menu().open(anchorEl, [
    { icon: ICONS.edit, label: t('menu.details'), onClick: () => openEditor(s) },
    { icon: ICONS.next, label: t('menu.playNext'), onClick: () => enqueueNext(s) },
    { icon: ICONS.queue, label: t('playlists.addToMenu'), onClick: () => synPlaylists && synPlaylists.addToPlaylistMenu(s, anchorEl) },
    { icon: ICONS.trash, label: t('common.delete'), danger: true, onClick: () => openDeleteModal(s) },
  ]);
}

// ====================== Modal de exclusão (dispositivo / PC / ambos) ======================
let deleteTarget = null;

function openDeleteModal(s) {
  deleteTarget = s;
  const title = s.title || (s.fileName || '').replace(/\.mp3$/i, '');
  $('deleteSong').textContent = `${s.artist ? s.artist + ' — ' : ''}${title}`;

  const onPc = !s.deviceOnly;
  const onDevice = !!s.deviceOnly || !!(devicesStore.activeDevice && devicesStore.syncedKeys.has(keyOf(s)));
  const nick = devicesStore.activeDevice ? (devicesStore.activeDevice.nickname || devicesStore.activeDevice.label || t('deleteModal.deviceFallback')) : t('deleteModal.deviceFallback');

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
  const serial = devicesStore.activeDevice ? devicesStore.activeDevice.serial : (s.serial || null);
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
    if (s.deviceOnly) devicesStore.setDeviceOnlySongs(devicesStore.deviceOnlySongs.filter((x) => x.filePath !== s.filePath));
    if (devicesStore.activeDevice) {
      try { const st = await window.api.deviceSyncState(devicesStore.activeDevice.serial); devicesStore.setSyncedKeys(st.keys || []); } catch { /* ok */ }
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

// ====================== Configurações (ilha syn-settings) ======================
// A view <syn-settings> (= #settingsModal, tag-swap) é dona do form + load/save/toggles/auth.
// Aqui só: injetar t/toast/closeView, abrir pelo botão da topbar, e reagir ao save (efeitos
// cross-subsistema: advancedEdit + caches + reload + karaokê).
const synSettings = document.querySelector('syn-settings');
if (synSettings) { synSettings.t = t; synSettings.toast = toast; synSettings.closeView = (el) => closeViewAnimated(el); }
$('settingsBtn').addEventListener('click', () => { if (synSettings) synSettings.open(); });
document.addEventListener('syn:settings:saved', (e) => {
  const d = e.detail || {};
  advancedEdit = d.advancedEdit;
  if (npOpen()) {
    if ($('nowPlaying').classList.contains('lyrics-mode')) renderNpLyrics(); // aplica/remove gutters
    updateChordsBtn();
  }
  if (d.geniusChanged && synLibrary) synLibrary.clearArtistCache();
  if (d.lastfmChanged) { for (const k of Object.keys(globalPlaycountCache)) delete globalPlaycountCache[k]; }
  reloadLibrary(); // a pasta pode ter mudado
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

// Ilha do grafo Web Audio + EQ (headless). Dona de audioCtx/analyser/eqFilters; os
// visualizadores abaixo leem synAudio.analyser/freqData; o engine chama synAudio.ensureGraph().
const synAudio = document.querySelector('syn-audio');
if (synAudio) Object.assign(synAudio, { audio, t, toast, blockedDuringLyricsEdit });

// ---- Visualizador de espectro (Web Audio API) ----
// Liga o <audio> a um AnalyserNode e desenha as frequências num canvas atrás
// do conteúdo do card. IMPORTANTE: ao criar o MediaElementSource o áudio passa
// a fluir pelo grafo — por isso o AudioContext precisa estar "running" (resume).

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
  if (!vizCanvas || !synAudio.analyser) { vizRAF = null; return; }
  const ctx = vizCtx;
  const w = vizCanvas.width, h = vizCanvas.height;
  ctx.clearRect(0, 0, w, h);
  synAudio.analyser.getByteFrequencyData(synAudio.freqData);

  const bins = synAudio.freqData.length;
  const bars = Math.min(44, bins);
  const usable = Math.floor(bins * 0.85); // descarta as frequências mais altas (quase sempre fracas)
  const step = Math.max(1, Math.floor(usable / bars));
  const gap = Math.max(1, w * 0.004);
  const bw = (w - gap * (bars - 1)) / bars;
  const r = Math.min(bw / 2, h * 0.02);
  vizCurPal = lerpPal(vizCurPal, barTargetPal, 0.09); // transição suave ao trocar de música
  const colors = deriveBarColors(vizCurPal);

  for (let i = 0; i < bars; i++) {
    let v = 0; for (let k = 0; k < step; k++) v += synAudio.freqData[i * step + k] || 0; v /= step;
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
  synAudio.ensureGraph();
  if (!synAudio.analyser) return;
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
async function confirmChordSwitch(index) {
  if (!npChordsDirty) return true;
  const next = queue[index];
  if (!next || (current && next.filePath === current.filePath)) return true;
  return askConfirm(t('chords.confirmDiscard'), { danger: true });
}

async function playAt(index) {
  if (index < 0 || index >= queue.length) return;
  if (!(await confirmChordSwitch(index))) return; // edições de acordes não salvas: usuário cancelou
  queueIndex = index;
  current = queue[index];
  $('player').classList.remove('hidden', 'closing');
  updatePlayerMeta();
  flareAmbient(); // o ambiente da biblioteca respira na cor da nova faixa
  loadCurrentLyrics(current.filePath); // prepara o karaokê para a nova faixa
  const ok = await loadAndPlay(current);
  if (!ok) return;
  markPlayingCards();
  if (synQueue) synQueue.render();
}

// toca a partir de um card: a fila vem da lista de contexto (visível, ou a do artista)
function playFromCard(song, listOverride) {
  synAudio.ensureGraph(); // cria/retoma o AudioContext dentro do gesto do usuário
  queue = (listOverride && listOverride.length ? listOverride : playerStore.visibleList).slice();
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
  if (synQueue) synQueue.render();
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
  if (synQueue) synQueue.render();
}

function removeFromQueue(i) {
  if (i === queueIndex) return; // a faixa atual não sai da fila
  queue.splice(i, 1);
  if (i < queueIndex) queueIndex--;
  if (synQueue) synQueue.render();
}

// toca uma lista de faixas a partir de um índice (cards de artista / botão Tocar)
function playList(list, idx = 0) {
  if (!list || !list.length) return;
  synAudio.ensureGraph();
  queue = list.slice();
  playAt(idx >= 0 && idx < list.length ? idx : 0);
}

function togglePlay() {
  if (!current) {
    // nada carregado: começa pela lista visível
    if (playerStore.visibleList.length) playFromCard(playerStore.visibleList[0]);
    return;
  }
  synAudio.ensureGraph(); // retoma o AudioContext dentro do gesto
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
  if (!synAudio.analyser || player.classList.contains('hidden')) { plVizRAF = null; return; }
  synAudio.analyser.getByteFrequencyData(synAudio.freqData);

  // energia dos graves → pulso (ataque rápido, queda suave)
  const nb = Math.max(4, synAudio.freqData.length >> 5);
  let e = 0; for (let i = 0; i < nb; i++) e += synAudio.freqData[i];
  e /= nb * 255;
  plBeat += (e - plBeat) * (e > plBeat ? 0.45 : 0.12);
  player.style.setProperty('--beat', plBeat.toFixed(3));

  plVizRAF = requestAnimationFrame(drawPlBeat);
}

function startPlViz() {
  if (plVizRAF) return;
  synAudio.ensureGraph();
  if (!synAudio.analyser) return;
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
    if (synQueue) synQueue.render();
  }
});
$('npEqBtn').addEventListener('click', () => {
  const p = $('eqPanel');
  const show = p.classList.contains('hidden');
  hideNpPanels();
  if (show && synAudio) synAudio.openNpPanel();
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
  if (!cv || !synAudio.analyser || !npOpen()) { npVizRAF = null; return; }
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height, cx = w / 2, cy = h / 2;
  ctx.clearRect(0, 0, w, h);
  synAudio.analyser.getByteFrequencyData(synAudio.freqData);

  // o anel acompanha o TAMANHO ATUAL DA CAPA (inclui o zoom do modo ocioso e a tela cheia)
  const coverRect = $('npCover').getBoundingClientRect();
  const cvRect = cv.getBoundingClientRect();
  const pxScale = cvRect.width ? (w / cvRect.width) : 1; // device px por css px
  const coverR = Math.max(40, (coverRect.width / 2) * pxScale);
  const baseR = coverR * 1.06;     // começa logo após a borda da capa
  const maxLen = coverR * 0.62;    // barras crescem ~60% do raio da capa (um pouco além)

  const bins = synAudio.freqData.length;
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
    const v = (synAudio.freqData[idx] || 0) / 255;
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
  synAudio.ensureGraph();
  // sempre re-injeta (cobre o early-return do ensureAnalyser quando o analyser já existia)
  if (_litViz) { _litViz.analyser = synAudio.analyser; _litViz.freqData = synAudio.freqData; _litViz.active = true; return; }
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
const _litPlayer = playerStore; // facade do player (store-núcleo): singleton eager, sempre disponível
let _litViz = null;    // visualizer Lit (Fase E): recebe analyser/freqData/coverEl/palette/active
_litReady.then((m) => {
  if (!m || !customElements.get('syn-toast')) return;
  try {
    const root = document.createElement('syn-app-root');
    root.appendChild(document.createElement('syn-toast'));
    document.body.appendChild(root);
    _litToast = (root.services && root.services.toast) || null;
    // PlayerService = singleton eager (mesma instância que o app-root provê via context).
    // Liga o <audio> real + estado inicial + transporte.
    if (_litPlayer) {
      _litPlayer.audio = audio;
      _litPlayer.setState({ volume: audio.volume, shuffle, repeatMode });
      // transporte: a facade delega às funções existentes do renderer
      _litPlayer.controls = {
        toggle: togglePlay, next: playNext, prev: playPrev,
        shuffle: toggleShuffle, repeat: cycleRepeat,
        seek: seekTo, setVolume,
        openNowPlaying, toggleEq: () => synAudio && synAudio.togglePanel(), toggleQueue: () => synQueue && synQueue.toggle(), closePlayer: closePlayerAction,
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
        if (synAudio.analyser) { v.analyser = synAudio.analyser; v.freqData = synAudio.freqData; } // se já criado
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
    if (vis('devicesModal')) { synDevices.close(); return; }
    if (vis('settingsModal')) { closeViewAnimated($('settingsModal')); return; }
    if (!$('eqPanel').classList.contains('hidden')) { $('eqPanel').classList.add('hidden'); return; }
    if (!$('queuePanel').classList.contains('hidden')) { if (synQueue) synQueue.close(); return; }
    if (vis('playlistPage')) { synPlaylists.closePage(); synPlaylists.open(); return; }
    if (vis('playlistsView')) { synPlaylists.closeGrid(); return; }
    if (vis('artistPage')) { if (synLibrary) synLibrary.closeArtist(); return; }
    if (synAdd && synAdd.isOpen()) { $('ytUrl').value = ''; synAdd.close(); return; }
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
    if (!current && !playerStore.visibleList.length) return;
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


// ====================== Dispositivos / sincronização ======================

// Status de loading na barra de ferramentas (sempre visível): prioriza
// downloads/enriquecimento em andamento; senão, mostra a varredura/sync do dispositivo.
let syncStatusMsg = null;
function refreshToolbarStatus() {
  // jobs de download (ilha syn-add) têm prioridade; senão, a varredura/sync do dispositivo
  let msg = (synAdd && synAdd.jobStatusMsg()) || syncStatusMsg;

  const el = $('toolbarStatus');
  if (msg) { $('toolbarStatusMsg').textContent = msg; el.classList.remove('hidden', 'closing'); }
  else el.classList.add('hidden');
}
function showScanIndicator(msg) { syncStatusMsg = msg || t('sync.scanning'); refreshToolbarStatus(); }
function hideScanIndicator() { syncStatusMsg = null; refreshToolbarStatus(); }

// ---- Central de dispositivos = ilha <syn-devices> (dona da lista/sync/notice/contexto) ----
// Estado nos stores; efeito cross-subsistema = intent syn:library:refresh. O renderer injeta
// glue/UI e aciona por métodos públicos (open/close/resync/initContext).
const synDevices = document.querySelector('syn-devices');
if (synDevices) {
  Object.assign(synDevices, { t, tn, toast, closeView: (el) => closeViewAnimated(el), showScanIndicator, hideScanIndicator });
}
$('devicesBtn').addEventListener('click', () => { if (synDevices) synDevices.open(); });
// re-sincroniza em 2º plano quando a biblioteca muda e há device ativo
function maybeResync() { if (synDevices) synDevices.resync(); }

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
    // As ilhas Lit foram montadas no microtask _litReady (eval do módulo), ANTES do
    // dicionário chegar (STR vazio) → as que usam t() inline no template renderaram a
    // shell com as chaves cruas. applyStaticI18n só cobre [data-i18n], não o template
    // da ilha. Re-renderiza as ilhas com o t já populado.
    document.querySelectorAll('syn-track-editor, syn-settings, syn-mini-player')
      .forEach((el) => { if (el.requestUpdate) el.requestUpdate(); });

    // a biblioteca é a tela inicial visível: carrega e renderiza primeiro
    console.debug('[startup] carregando biblioteca…');
    await reloadLibrary();
    console.debug('[startup] biblioteca pronta em', Date.now() - t0, 'ms');
  } finally {
    clearTimeout(splashFailsafe);
    dismissStartupSplash();
  }

  // o restante da inicialização não bloqueia a exibição da tela inicial
  Promise.all([playlistsStore.load(), synDevices ? synDevices.initContext() : null, synAudio ? synAudio.initEq() : null]).catch(() => {});
  window.api.getConfig().then((cfg) => {
    if (cfg) advancedEdit = cfg.advancedEdit === true;
    if (cfg && !cfg.apiKey) {
      setTimeout(() => toast(t('settings.configureKey'), ''), 600);
    }
  }).catch(() => {});
});

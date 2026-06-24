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


// Player — estado de reprodução agora é fonte ÚNICA no playerStore (store-núcleo).
// O engine escreve em playerStore.{current,isPlaying,queue,queueIndex,shuffle,repeatMode};
// os componentes (mini-player/now-playing/lyrics/viz) leem o MESMO singleton. As funções
// update*/sync* abaixo continuam notificando as ilhas (emitChange via setState).


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
    if (playerStore.current && playerStore.current.filePath === s.filePath) togglePlay();
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
if (synQueue) Object.assign(synQueue, { t, coverUrl, coverState, getQueue: () => playerStore.queue, getIndex: () => playerStore.queueIndex });
// Editor de detalhes (cola; owns #editorBackdrop/#cropModal/#lyricsModal). Capacidades
// próprias (loading/confirm/palette); engine via intents.
const synEditor = document.querySelector('syn-editor');
if (synEditor) Object.assign(synEditor, { t, toast, coverState, makeCenterCrop, closeView: (el) => closeViewAnimated(el) });

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
  document.addEventListener('syn:player:play', (e) => { if (e.detail && e.detail.song) playFromCard(e.detail.song); });
  document.addEventListener('syn:player:before-save', (e) => { if (playerStore.current && playerStore.current.filePath === e.detail.filePath) audioReloading = true; });
  document.addEventListener('syn:player:reload-current', (e) => { if (playerStore.current && playerStore.current.filePath === e.detail.filePath) { npLyricsPath = null; loadCurrentLyrics(playerStore.current.filePath); reloadCurrentAudio(); } });
  document.addEventListener('syn:delete:open', (e) => openDeleteModal(e.detail.song));
}
wireViewIntents();


// ====================== Menu de opções da música (⋯) ======================
// Usa a capacidade <syn-menu> (portal/posição/fechar próprios). Itens = ações.
function openSongMenu(s, anchorEl) {
  menu().open(anchorEl, [
    { icon: ICONS.edit, label: t('menu.details'), onClick: () => synEditor && synEditor.open(s) },
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


$('cropModal').addEventListener('click', (e) => { if (e.target === $('cropModal') && synEditor) synEditor.closeCropper(); });

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
  if (synNowPlaying.isOpen()) {
    if (synNowPlaying.isLyricsMode()) renderNpLyrics(); // aplica/remove gutters
    updateChordsBtn();
  }
  if (d.geniusChanged && synLibrary) synLibrary.clearArtistCache();
  if (d.lastfmChanged && synEditor) synEditor.clearPlaycountCache();
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
  if (!playerStore.current) { stopVisualizer(); return; }
  const sel = (window.CSS && CSS.escape) ? CSS.escape(playerStore.current.filePath) : playerStore.current.filePath;
  const el = document.querySelector(`.song-card[data-path="${sel}"]`);
  if (!el) { stopVisualizer(); return; }
  el.classList.add('playing');
  if (playerStore.isPlaying) {
    startVisualizer(el, playerStore.current.coverDataUrl);
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
  const cur = playerStore.current;
  if (!cur) return;
  const title = cur.title || (cur.fileName || '').replace(/\.mp3$/i, '') || '—';
  const artist = cur.artist || '';
  // player-half: null-guard (após o swap p/ syn-mini-player esses ids somem; a facade abaixo dirige)
  { const e = $('playerTitle'); if (e) e.textContent = title; }
  { const e = $('playerArtist'); if (e) e.textContent = artist; }
  { const e = $('playerCover'); if (e) setCoverEl(e, cur); }
  $('npTitle').textContent = title;
  $('npArtist').textContent = artist;
  setCoverEl($('npCover'), cur);
  // tinge a UI com a cor da capa (null se sabidamente sem capa)
  applyNowColor(coverState.get(cur.filePath) === false ? null : coverUrl(cur));
  // facade: estado discreto p/ os componentes do player (sub-passo 1 da Fase D)
  if (_litPlayer) _litPlayer.setState({ title, artist, current: cur, coverUrl: coverState.get(cur.filePath) === false ? null : coverUrl(cur) });
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
  const ic = playerStore.isPlaying ? ICONS.pause : ICONS.play;
  { const e = $('playBtn'); if (e) e.innerHTML = ic; }
  $('npPlay').innerHTML = ic;
  if (_litPlayer) _litPlayer.setState({ isPlaying: playerStore.isPlaying });
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
  if (!playerStore.current) return;
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
  audio.src = 'mp3file://' + encodeURIComponent(playerStore.current.filePath) + '?v=' + Date.now();
}

// Avisa antes de trocar de faixa com edições de acordes não salvas. Retorna false
// (abortar) se o usuário cancelar; true caso contrário (sem edições, mesma faixa, ou OK).
async function confirmChordSwitch(index) {
  if (!npChordsDirty) return true;
  const next = playerStore.queue[index];
  if (!next || (playerStore.current && next.filePath === playerStore.current.filePath)) return true;
  return askConfirm(t('chords.confirmDiscard'), { danger: true });
}

async function playAt(index) {
  if (index < 0 || index >= playerStore.queue.length) return;
  if (!(await confirmChordSwitch(index))) return; // edições de acordes não salvas: usuário cancelou
  playerStore.queueIndex = index;
  playerStore.current = playerStore.queue[index];
  $('player').classList.remove('hidden', 'closing');
  updatePlayerMeta();
  flareAmbient(); // o ambiente da biblioteca respira na cor da nova faixa
  loadCurrentLyrics(playerStore.current.filePath); // prepara o karaokê para a nova faixa
  const ok = await loadAndPlay(playerStore.current);
  if (!ok) return;
  markPlayingCards();
  if (synQueue) synQueue.render();
}

// toca a partir de um card: a fila vem da lista de contexto (visível, ou a do artista)
function playFromCard(song, listOverride) {
  synAudio.ensureGraph(); // cria/retoma o AudioContext dentro do gesto do usuário
  playerStore.queue = (listOverride && listOverride.length ? listOverride : playerStore.visibleList).slice();
  let idx = playerStore.queue.findIndex((s) => s.filePath === song.filePath);
  if (idx < 0) { playerStore.queue = [song]; idx = 0; } // faixa fora da lista visível: toca só ela
  playAt(idx);
}
// "Tocar a seguir": insere a faixa logo após a atual na fila (sem interromper)
function enqueueNext(s) {
  if (!playerStore.current) { playFromCard(s); return; } // nada tocando: toca direto
  const existing = playerStore.queue.findIndex((x) => x.filePath === s.filePath);
  if (existing === playerStore.queueIndex) { toast(t('player.alreadyPlaying'), ''); return; }
  if (existing >= 0) {
    playerStore.queue.splice(existing, 1);
    if (existing < playerStore.queueIndex) playerStore.queueIndex--;
  }
  playerStore.queue.splice(playerStore.queueIndex + 1, 0, s);
  if (synQueue) synQueue.render();
  const title = s.title || (s.fileName || '').replace(/\.mp3$/i, '');
  toast(t('player.playsNext', { title }), 'success');
}

// reordena a fila por arraste, preservando a faixa atual
function reorderQueue(from, to) {
  const q = playerStore.queue;
  if (from === to || from < 0 || to < 0 || from >= q.length || to >= q.length) return;
  const [m] = q.splice(from, 1);
  q.splice(to, 0, m);
  if (playerStore.queueIndex === from) playerStore.queueIndex = to;
  else if (from < playerStore.queueIndex && to >= playerStore.queueIndex) playerStore.queueIndex--;
  else if (from > playerStore.queueIndex && to <= playerStore.queueIndex) playerStore.queueIndex++;
  if (synQueue) synQueue.render();
}

function removeFromQueue(i) {
  if (i === playerStore.queueIndex) return; // a faixa atual não sai da fila
  playerStore.queue.splice(i, 1);
  if (i < playerStore.queueIndex) playerStore.queueIndex--;
  if (synQueue) synQueue.render();
}

// toca uma lista de faixas a partir de um índice (cards de artista / botão Tocar)
function playList(list, idx = 0) {
  if (!list || !list.length) return;
  synAudio.ensureGraph();
  playerStore.queue = list.slice();
  playAt(idx >= 0 && idx < list.length ? idx : 0);
}

function togglePlay() {
  if (!playerStore.current) {
    // nada carregado: começa pela lista visível
    if (playerStore.visibleList.length) playFromCard(playerStore.visibleList[0]);
    return;
  }
  synAudio.ensureGraph(); // retoma o AudioContext dentro do gesto
  if (audio.paused) audio.play(); else audio.pause();
}

function nextIndex() {
  const qi = playerStore.queueIndex, q = playerStore.queue;
  if (playerStore.repeatMode === 'one') return qi;
  if (playerStore.shuffle) {
    if (q.length <= 1) return qi;
    let r;
    do { r = Math.floor(Math.random() * q.length); } while (r === qi);
    return r;
  }
  if (qi + 1 < q.length) return qi + 1;
  return playerStore.repeatMode === 'all' ? 0 : -1;
}

function playNext() {
  const i = nextIndex();
  if (i < 0) { playerStore.isPlaying = false; updatePlayButton(); markPlayingCards(); return; }
  playAt(i);
}

function playPrev() {
  // se já passou de 3s, reinicia a faixa; senão volta uma
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (playerStore.shuffle) { playAt(nextIndex()); return; }
  if (playerStore.queueIndex - 1 >= 0) playAt(playerStore.queueIndex - 1);
  else audio.currentTime = 0;
}

// ---- Eventos do elemento de áudio ----
audio.addEventListener('play', () => { playerStore.isPlaying = true; updatePlayButton(); markPlayingCards(); syncNpViz(); syncPlViz(); });
audio.addEventListener('pause', () => { playerStore.isPlaying = false; updatePlayButton(); markPlayingCards(); syncNpViz(); syncPlViz(); });
audio.addEventListener('ended', () => {
  // com acordes não salvos, não avança automaticamente (preservaria as edições): pausa e avisa
  if (npChordsDirty) { toast(t('chords.unsaved'), ''); playerStore.isPlaying = false; updatePlayButton(); markPlayingCards(); return; }
  playNext();
});
audio.addEventListener('timeupdate', () => {
  if (audio.duration) {
    if (!window.currentScrobbled && (audio.currentTime > audio.duration / 2 || audio.currentTime > 240)) {
      window.currentScrobbled = true;
      // lê do objeto `current` (não do DOM — o mini-player Lit não tem #playerArtist)
      const cur = playerStore.current;
      const tArtist = (cur && cur.artist) || '';
      const tTitle = (cur && (cur.title || (cur.fileName || '').replace(/\.mp3$/i, ''))) || '';
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
    if (synNowPlaying.isOpen() && synNowPlaying.isLyricsMode()) updateKaraoke(audio.currentTime);
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
  if (playerStore.current && !audioReloading) toast(t('player.playbackError'), 'error');
});

// ---- Controles (espelhados entre o mini-player e a Now Playing) ----
function toggleShuffle() { playerStore.shuffle = !playerStore.shuffle; syncShuffleBtn(); }
function syncShuffleBtn() {
  const shuffle = playerStore.shuffle;
  { const e = $('shuffleBtn'); if (e) e.classList.toggle('active', shuffle); }
  $('npShuffle').classList.toggle('active', shuffle);
  if (_litPlayer) _litPlayer.setState({ shuffle });
}
function cycleRepeat() {
  playerStore.repeatMode = playerStore.repeatMode === 'off' ? 'all' : (playerStore.repeatMode === 'all' ? 'one' : 'off');
  syncRepeatBtn();
}
function syncRepeatBtn() {
  const repeatMode = playerStore.repeatMode;
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
  synNowPlaying.close();
  playerStore.current = null; playerStore.isPlaying = false;
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
  if (playerStore.isPlaying && !$('player').classList.contains('hidden')) startPlViz();
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
  if (!playerStore.current || audio.paused || audio.volume <= 0.01) { window.api.fadeoutDone(); return; }
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

// ---- Now Playing (tela cheia) = ilha <syn-now-playing> ----
// O SHELL (lifecycle/idle/fullscreen/painéis/transporte/meta reativa) vive no componente
// (controller-by-id; dono de #nowPlaying + botões). O renderer mantém o HOT-PATH: anel do
// espectro (viz, abaixo) e karaokê (ilha syn-lyrics) — acionados pelos intents da NP.
let npVizRAF = null;

const synNowPlaying = document.querySelector('syn-now-playing');
if (synNowPlaying) Object.assign(synNowPlaying, {
  t,
  blockedDuringLyricsEdit: () => blockedDuringLyricsEdit(),
  closeView: (el) => closeViewAnimated(el),
});

// Intents da NP → o renderer (dono do viz/karaokê) executa.
document.addEventListener('syn:np:opened', () => {
  syncNpViz();
  if (synNowPlaying.isLyricsMode()) { npLastCenter = null; npLyricCurTop = null; updateKaraoke(audio.currentTime); }
  updateChordsBtn();
  syncLyricScroll();
});
document.addEventListener('syn:np:closed', () => {
  stopNpViz();
  const ly = litLyricsEl(); if (ly) ly.active = false; // para o rAF da ilha de letra ao fechar
});
document.addEventListener('syn:np:lyrics-toggle', (e) => {
  if (e.detail && e.detail.on) { npShowChords = false; renderNpLyrics(); npLastCenter = null; npLyricCurTop = null; updateKaraoke(audio.currentTime); }
  updateChordsBtn();
  syncLyricScroll();
});
document.addEventListener('syn:np:chords-action', () => {
  if (npChordsDirty) { saveChordsInline(); return; }
  npShowChords = !npShowChords;
  renderNpLyrics();
  npLastCenter = null; npLyricCurTop = null; updateKaraoke(audio.currentTime);
});
document.addEventListener('syn:np:queue-render', () => { if (synQueue) synQueue.render(); });
document.addEventListener('syn:np:eq-open', () => { if (synAudio) synAudio.openNpPanel(); });
document.addEventListener('syn:np:resize', () => sizeNpViz());

// Abre o modo imersivo já em karaokê para a faixa de demonstração — concentra o
// "uau" (ambiente colorido + letra sincronizada) num clique, sem o usuário caçar botões.
// Pequeno atraso deixa a onda de cor do card aparecer antes do imersivo deslizar.
function revealDemoImmersive() {
  setTimeout(() => {
    if (!playerStore.current || !isDemoTrack(playerStore.current)) return; // trocou de faixa nesse meio-tempo
    synNowPlaying.open();
    if (!synNowPlaying.isLyricsMode()) synNowPlaying.setLyricsMode(true); // entra no karaokê (chords off via handler)
  }, 260);
}

// Editor de letra aberto? Bloqueia ações do mini-player que conflitam com a edição.
function lyricsEditorOpen() {
  return !!(synEditor && synEditor.isLyricsEditorOpen());
}
function blockedDuringLyricsEdit() {
  if (lyricsEditorOpen()) {
    toast(t('lyrics.toast.finishEdit'), '');
    return true;
  }
  return false;
}

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
  if (!cv || !synAudio.analyser || !synNowPlaying.isOpen()) { npVizRAF = null; return; }
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
  if (!synNowPlaying.isOpen()) { stopNpViz(); return; }
  if (playerStore.isPlaying) startNpViz(); else stopNpViz();
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
      _litPlayer.setState({ volume: audio.volume, shuffle: _litPlayer.shuffle, repeatMode: _litPlayer.repeatMode });
      // transporte: a facade delega às funções existentes do renderer
      _litPlayer.controls = {
        toggle: togglePlay, next: playNext, prev: playPrev,
        shuffle: toggleShuffle, repeat: cycleRepeat,
        seek: seekTo, setVolume,
        openNowPlaying: () => synNowPlaying.open(), toggleEq: () => synAudio && synAudio.togglePanel(), toggleQueue: () => synQueue && synQueue.toggle(), closePlayer: closePlayerAction,
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
          if (_litPlayer.current) _litPlayer.setState({ title: _litPlayer.current.title || '', artist: _litPlayer.current.artist || '', current: _litPlayer.current });
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
        if (synNowPlaying.isOpen() && playerStore.isPlaying) v.active = true; // já tocando c/ NP aberta
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
function syncLitLyrics() { const ly = litLyricsEl(); if (ly) ly.active = synNowPlaying.isOpen() && synNowPlaying.isLyricsMode(); }

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
  ly.active = synNowPlaying.isOpen() && synNowPlaying.isLyricsMode();
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

// Os cliques de letra/acordes (#npLyricsBtn/#npChordsBtn) são da <syn-now-playing>, que
// emite syn:np:lyrics-toggle / syn:np:chords-action — tratados nos handlers de intent acima.

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
  if (!playerStore.current) return;
  const lrc = (npChordsLines || [])
    .filter((c) => c.text && c.text.trim())
    .slice().sort((a, b) => a.t - b.t)
    .map((c) => `[${msStamp(c.t)}]${c.text.trim()}`)
    .join('\n');
  audioReloading = true; // o arquivo será reescrito sob o stream
  try {
    const res = await window.api.chordsSet(playerStore.current.filePath, lrc);
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
    if (synNowPlaying.isFullscreen()) { e.preventDefault(); synNowPlaying.toggleFullscreen(); return; }
    if (synNowPlaying.isOpen() && synNowPlaying.panelOpen()) { e.preventDefault(); synNowPlaying.hidePanels(); return; }
    if (synNowPlaying.isOpen() && synNowPlaying.isLyricsMode()) {
      e.preventDefault(); synNowPlaying.setLyricsMode(false); return;
    }
    if (synNowPlaying.isOpen()) { e.preventDefault(); synNowPlaying.close(); return; }
    if (vis('cropModal')) { if (synEditor) synEditor.closeCropper(); return; }
    if (vis('deleteModal')) { closeDeleteModal(); return; }
    if (vis('editorBackdrop')) { if (synEditor) synEditor.onEscape(); return; }
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
  if (synNowPlaying.isOpen() && playerStore.current) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); playPrev(); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); playNext(); return; }
  }

  // Espaço: tocar/pausar
  if (e.code === 'Space') {
    if (!playerStore.current && !playerStore.visibleList.length) return;
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
window.addEventListener('resize', () => { if (synNowPlaying.isOpen()) sizeNpViz(); });

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

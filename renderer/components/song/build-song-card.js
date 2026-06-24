// Folha COMPARTILHADA: factory do card de faixa (<syn-song-card>). View pura — só prepara
// o VM e o contexto (song/queue) no elemento. As AÇÕES (play/menu/cover) sobem como intents
// (eventos bubbles do componente) e são tratadas por DELEGAÇÃO no renderer
// (wireSongCardDelegation), não por closure por-card. Assim qualquer view (biblioteca/
// playlists/álbum) constrói cards com a mesma folha, sem acoplar a folha ao renderer.
//
// Estado: lê só dos stores-núcleo (devicesStore p/ badges de sync; playerStore p/ a classe
// "playing"). i18n + helpers de capa/subtítulo são singletons app-global, injetados UMA vez
// via configureSongCard (não são deps por-view).
import './syn-song-card.js';
import { keyOf } from '../../modules/format.js';
import { devicesStore, playerStore } from '../../services/core-store.js';

let _t = (k) => k;
let _coverUrl = () => '';
let _coverState = new Map();
let _songSubtitle = () => '';
/** Injeta as dependências app-global (chamado 1x no boot do renderer). */
export function configureSongCard({ t, coverUrl, coverState, songSubtitle } = {}) {
  if (t) _t = t;
  if (coverUrl) _coverUrl = coverUrl;
  if (coverState) _coverState = coverState;
  if (songSubtitle) _songSubtitle = songSubtitle;
}

/** View-model do card (o componente é view pura, dirigida por VM). */
export function songVM(s) {
  const synced = devicesStore.hasSyncContext && devicesStore.syncedKeys.has(keyOf(s));
  return {
    path: s.filePath,
    title: s.title || s.fileName.replace(/\.mp3$/i, ''),
    sub: _songSubtitle(s),
    src: _coverUrl(s),
    coverKnown: _coverState.get(s.filePath),
    deviceOnly: !!s.deviceOnly,
    badge: s.deviceOnly
      ? { kind: 'device', label: _t('badges.onDevice'), title: _t('badges.onDeviceTitle') }
      : (devicesStore.hasSyncContext ? { kind: 'sync', synced, label: synced ? _t('badges.syncedTitle') : _t('badges.notSyncedTitle') } : null),
  };
}

/**
 * Cria um card de faixa. SEM handlers: play/menu/cover sobem por bubbling e são tratados
 * pela delegação no renderer, que lê `_song`/`_queue` deste elemento.
 * @param {object} s faixa  @param {object[]} [queueList] base da fila ao tocar a partir daqui
 */
export function buildSongCard(s, queueList) {
  const el = document.createElement('syn-song-card');
  el.vm = songVM(s);
  el.t = _t;
  el._song = s;
  el._queue = queueList;
  const cur = playerStore.current;
  if (cur && cur.filePath === s.filePath) {
    el.classList.add('playing');
    if (!playerStore.isPlaying) el.classList.add('paused');
  }
  return el;
}

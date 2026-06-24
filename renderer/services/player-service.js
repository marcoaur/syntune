// PlayerService (contrato §2.1) — FACADE do player (Fase D, sub-passo 1).
// Fonte ÚNICA do estado de reprodução p/ os componentes (mini-player/now-playing). O
// renderer SINCRONIZA o estado aqui (setState) e DELEGA o transporte (controls.*) às suas
// funções existentes — sem reescrever a engine de áudio. Tempo/duração: getters lidos do
// <audio> (o componente lê por frame via RafController; não passa por re-render).
import { StoreService } from './store-service.js';

export class PlayerService extends StoreService {
  constructor() {
    super();
    /** @type {HTMLAudioElement|null} */
    this.audio = null; // injetado pelo renderer (o <audio> real)
    /** @type {object|null} */ this.current = null;
    /** @type {object[]} */ this.queue = [];
    /** lista ordenada renderizada pela biblioteca = base da fila ao tocar um card. */
    /** @type {object[]} */ this.visibleList = [];
    // estado discreto consumido pelos componentes (sincronizado pelo renderer):
    this.title = '';
    this.artist = '';
    this.coverUrl = null;   // string | null (null = sem capa → placeholder)
    this.isPlaying = false;
    this.shuffle = false;
    this.repeatMode = 'off'; // 'off' | 'all' | 'one'
    this.volume = 1;
    this.visible = false;
    // hooks de transporte: o renderer atribui (toggle/next/prev/seek/setVolume/...).
    this.controls = {};
  }

  get currentTime() { return this.audio ? this.audio.currentTime : 0; }
  get duration() { return this.audio && isFinite(this.audio.duration) ? this.audio.duration : 0; }

  /** Sincroniza estado discreto + notifica os consumidores (events down → re-render). */
  setState(patch) { Object.assign(this, patch); this.emitChange(patch); }

  // Transporte: delega às funções do renderer (controls.*); fallback no <audio> p/ a ilha de acordes.
  seek(t) {
    if (this.audio) { this.audio.currentTime = Math.max(0, t); if (this.audio.paused) this.audio.play().catch(() => {}); }
  }
  seekFraction(f) { if (this.controls.seek) this.controls.seek(Math.round(f * 1000)); }
  toggle() { this.controls.toggle ? this.controls.toggle() : (this.audio && (this.audio.paused ? this.audio.play().catch(() => {}) : this.audio.pause())); }
  next() { this.controls.next && this.controls.next(); }
  prev() { this.controls.prev && this.controls.prev(); }
  toggleShuffle() { this.controls.shuffle && this.controls.shuffle(); }
  cycleRepeat() { this.controls.repeat && this.controls.repeat(); }
  setVolume(v) { this.controls.setVolume && this.controls.setVolume(v); }
  openNowPlaying() { this.controls.openNowPlaying && this.controls.openNowPlaying(); }
  toggleEq() { this.controls.toggleEq && this.controls.toggleEq(); }
  toggleQueue() { this.controls.toggleQueue && this.controls.toggleQueue(); }
  closePlayer() { this.controls.closePlayer && this.controls.closePlayer(); }
}

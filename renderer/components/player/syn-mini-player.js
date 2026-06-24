// <syn-mini-player> — rodapé do player (Fase D). Light-DOM (host = #player.player) → reusa
// toda a CSS .player/.pl-* e o que o renderer faz no host ($('player') beat/drag/estilo do
// editor de letra seguem). Consome o PlayerService (facade) por PROPRIEDADE (não context —
// o #player não fica sob um app-root). Estado discreto via onChange (re-render); tempo do
// seek via RafController lendo player.currentTime (hot-path, escrita imperativa — sem re-render).
import { LitElement, html } from 'lit';
import { RafController } from '../controllers/raf-controller.js';
import '../control/syn-icon.js';

const fmtTime = (sec) => {
  if (!isFinite(sec) || sec < 0) sec = 0;
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
};
const fill = (el) => {
  if (!el) return;
  const min = parseFloat(el.min) || 0, max = parseFloat(el.max), v = parseFloat(el.value) || 0;
  el.style.setProperty('--fill', ((isFinite(max) && max > min) ? ((v - min) / (max - min)) * 100 : 0) + '%');
};

export class SynMiniPlayer extends LitElement {
  static properties = {
    player: { attribute: false },
    t: { attribute: false },
  };

  createRenderRoot() { return this; }

  constructor() {
    super();
    this.player = null;
    this.t = (k) => k;
    this._unsub = null;
    this._showRemaining = false;
    try { this._showRemaining = localStorage.getItem('player.showRemaining') === '1'; } catch { /* ok */ }
    this._raf = new RafController(this, () => this.#tick());
    this._seeking = false;
  }

  #tr(k) { return this.t ? this.t(k) : k; }
  get #p() { return this.player; }

  connectedCallback() {
    super.connectedCallback();
    if (this.player) this._unsub = this.player.onChange(() => this.requestUpdate());
    this._raf.start();
    // ondulação tátil nos botões (reproduz o efeito legado; .pl-ripple é CSS global)
    this.addEventListener('pointerdown', (e) => {
      const btn = e.target.closest && e.target.closest('.pl-btn');
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
  }
  disconnectedCallback() { super.disconnectedCallback(); if (this._unsub) this._unsub(); }

  updated(changed) {
    if (changed.has('player') && this.player && !this._unsub) {
      this._unsub = this.player.onChange(() => this.requestUpdate());
    }
  }

  // hot-path: posição do seek + tempos por frame (sem re-render)
  #tick() {
    const p = this.player;
    if (!p) return;
    const dur = p.duration, cur = p.currentTime;
    const seek = this.querySelector('.pl-seek');
    if (seek && dur && !this._seeking) { seek.value = String(Math.round((cur / dur) * 1000)); fill(seek); }
    const curEl = this.querySelector('.pl-time-cur');
    if (curEl) curEl.textContent = fmtTime(cur);
    const durEl = this.querySelector('.pl-time-dur');
    if (durEl && dur) durEl.textContent = this._showRemaining ? '-' + fmtTime(dur - cur) : fmtTime(dur);
  }

  #onSeek(e) { const p = this.player; if (p) p.seekFraction(parseInt(e.target.value, 10) / 1000); }
  #seekWheel(e) {
    e.preventDefault();
    const p = this.player; if (!p || !p.duration) return;
    p.seek(Math.min(p.duration, Math.max(0, p.currentTime + (e.deltaY < 0 ? 5 : -5))));
  }
  #seekHover(e) {
    const p = this.player; if (!p || !p.duration) return;
    const seek = e.currentTarget, tip = this.querySelector('.seek-tip');
    if (!tip) return;
    const r = seek.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    tip.textContent = fmtTime(pct * p.duration);
    const host = seek.parentElement.getBoundingClientRect();
    tip.style.left = (e.clientX - host.left) + 'px';
  }
  #vol(e) { const p = this.player; if (p) p.setVolume(parseFloat(e.target.value)); }
  #volWheel(e) {
    e.preventDefault();
    const p = this.player; if (!p) return;
    p.setVolume(Math.min(1, Math.max(0, (p.volume || 0) + (e.deltaY < 0 ? 0.05 : -0.05))));
  }
  #toggleDur(e) {
    e.stopPropagation();
    this._showRemaining = !this._showRemaining;
    try { localStorage.setItem('player.showRemaining', this._showRemaining ? '1' : '0'); } catch { /* ok */ }
  }

  render() {
    const p = this.player || {};
    const playIcon = p.isPlaying ? 'pause' : 'play';
    const repeatIcon = p.repeatMode === 'one' ? 'repeatOne' : 'repeat';
    return html`
      <div class="player-main">
        <div class="player-id" title=${this.#tr('player.openNow')} @click=${() => p.openNowPlaying && p.openNowPlaying()}>
          <div class="player-cover" @wheel=${(e) => this.#volWheel(e)}>
            ${p.coverUrl ? html`<img alt="" src=${p.coverUrl} />` : html`<span class="ph">♪</span>`}
          </div>
          <span class="player-expand"><syn-icon name="expandUp"></syn-icon></span>
          <div class="player-text">
            <div class="player-title">${p.title || '—'}</div>
            <div class="player-artist">${p.artist || ''}</div>
          </div>
        </div>
        <div class="player-controls">
          <button class="pl-btn ${p.shuffle ? 'active' : ''}" title=${this.#tr('player.shuffle')} @click=${() => p.toggleShuffle && p.toggleShuffle()}><syn-icon name="shuffle"></syn-icon></button>
          <button class="pl-btn" title=${this.#tr('player.prev')} @click=${() => p.prev && p.prev()}><syn-icon name="prev"></syn-icon></button>
          <button class="pl-btn play" title=${this.#tr('player.playPause')} @click=${() => p.toggle && p.toggle()}><syn-icon name=${playIcon}></syn-icon></button>
          <button class="pl-btn" title=${this.#tr('player.next')} @click=${() => p.next && p.next()}><syn-icon name="next"></syn-icon></button>
          <button class="pl-btn ${p.repeatMode !== 'off' ? 'active' : ''}" title=${this.#tr('player.repeat')} @click=${() => p.cycleRepeat && p.cycleRepeat()}><syn-icon name=${repeatIcon}></syn-icon></button>
        </div>
        <div class="player-extra">
          <button class="pl-btn" title=${this.#tr('eq.title')} @click=${() => p.toggleEq && p.toggleEq()}><syn-icon name="eq"></syn-icon></button>
          <button class="pl-btn" title=${this.#tr('player.queue')} @click=${() => p.toggleQueue && p.toggleQueue()}><syn-icon name="queue"></syn-icon></button>
          <span class="pl-vol" @wheel=${(e) => this.#volWheel(e)}>
            <span class="pl-vol-icon"><syn-icon name="volume"></syn-icon></span>
            <input class="pl-vol-range" type="range" min="0" max="1" step="0.01" .value=${String(p.volume ?? 1)} @input=${(e) => this.#vol(e)} />
          </span>
          <button class="pl-btn pl-close" title=${this.#tr('player.closePlayer')} @click=${() => p.closePlayer && p.closePlayer()}><syn-icon name="close"></syn-icon></button>
        </div>
      </div>
      <div class="player-seek">
        <span class="seek-tip">0:00</span>
        <span class="pl-time pl-time-cur">0:00</span>
        <input class="pl-seek" type="range" min="0" max="1000" value="0"
          @input=${(e) => this.#onSeek(e)} @wheel=${(e) => this.#seekWheel(e)}
          @mouseenter=${(e) => e.currentTarget.parentElement.querySelector('.seek-tip').classList.add('on')}
          @mouseleave=${(e) => e.currentTarget.parentElement.querySelector('.seek-tip').classList.remove('on')}
          @mousemove=${(e) => this.#seekHover(e)}
          @pointerdown=${() => { this._seeking = true; }} @pointerup=${() => { this._seeking = false; }} />
        <span class="pl-time pl-time-dur" title=${this.#tr('player.toggleRemaining')} @click=${(e) => this.#toggleDur(e)}>0:00</span>
      </div>
    `;
  }
}

customElements.define('syn-mini-player', SynMiniPlayer);

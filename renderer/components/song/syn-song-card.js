// <syn-song-card> — card de faixa da biblioteca (categoria 'song', Fase C — o core/hot).
// Light-DOM (createRenderRoot → this): reusa a CSS da lista (.song-card/.song-thumb/...) e os
// querySelectors do renderer (markPlayingCards/visualizer fazem `.song-card[data-path]` → o host
// vira isso). Dirigido por VM (o renderer prepara title/sub/src/badge via coverUrl/songSubtitle).
// É VIEW + intents: emite syn:song:play / :menu / :cover; a orquestração (play/menu/paleta) fica
// no renderer (anexada com o closure no buildSongCard). Compõe folhas syn-icon + syn-sync-badge.
//
// Capa: estado reativo (unknown→skeleton, ok→img, none→placeholder) SEM recriar o <img> (mesmo
// nó/src → sem reload/flicker). content-visibility/lazy mantidos pela CSS + loading=lazy (§3.1).
import { LitElement, html } from 'lit';
import '../control/syn-icon.js';
import '../control/syn-sync-badge.js';

export class SynSongCard extends LitElement {
  static properties = {
    vm: { attribute: false },        // { path, title, sub, src, coverKnown, deviceOnly, badge }
    t: { attribute: false },
    _cover: { state: true },         // 'unknown' | 'ok' | 'none'
  };

  createRenderRoot() { return this; }

  constructor() {
    super();
    this.vm = null;
    this.t = (k) => k;
    this._cover = 'unknown';
  }

  willUpdate(changed) {
    if (changed.has('vm') && this.vm) {
      this._cover = this.vm.coverKnown === false ? 'none' : (this.vm.coverKnown === true ? 'ok' : 'unknown');
    }
  }

  updated() {
    const vm = this.vm || {};
    this.classList.add('song-card');
    this.classList.toggle('device-only', !!vm.deviceOnly);
    if (vm.path) this.dataset.path = vm.path;
  }

  #emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail })); }

  #onLoad() { this._cover = 'ok'; this.#emit('syn:song:cover', { path: this.vm.path, src: this.vm.src, ok: true }); }
  #onError() { this._cover = 'none'; this.#emit('syn:song:cover', { path: this.vm.path, src: this.vm.src, ok: false }); }

  #badge(b) {
    if (!b) return '';
    if (b.kind === 'device') return html`<span class="device-only-badge" title=${b.title}>${b.label}</span>`;
    return html`<syn-sync-badge status=${b.synced ? 'synced' : 'unsynced'} label=${b.label}></syn-sync-badge>`;
  }

  render() {
    const vm = this.vm;
    if (!vm) return html``;
    return html`
      ${vm.row ? html`<span class="pl-drag"><syn-icon name="grip"></syn-icon></span>` : ''}
      <div class="song-thumb">
        ${this._cover === 'none'
          ? html`<span class="ph">♪</span>`
          : html`
              ${this._cover === 'unknown' ? html`<span class="cover-skel"></span>` : ''}
              <img alt="" loading="lazy" decoding="async" src=${vm.src} @load=${() => this.#onLoad()} @error=${() => this.#onError()} />`}
        <div class="thumb-overlay">
          <span class="ov-play"><syn-icon name="play"></syn-icon></span>
          <span class="ov-pause"><syn-icon name="pause"></syn-icon></span>
        </div>
      </div>
      <div class="song-info">
        <div class="song-title-row"><span class="now-eq"><i></i><i></i><i></i></span><div class="song-title">${vm.title}</div></div>
        <div class="song-sub">${vm.sub}</div>
      </div>
      <div class="song-badges">${this.#badge(vm.badge)}</div>
      <button class="song-menu" title=${this.t('common.edit')}
        @click=${(e) => { e.stopPropagation(); this.#emit('syn:song:menu', { path: vm.path }); }}>⋯</button>
      ${vm.row ? html`<button class="pl-remove" title=${this.t('playlists.removeTrack')}
        @click=${(e) => { e.stopPropagation(); this.#emit('syn:song:remove', { path: vm.path }); }}><syn-icon name="close"></syn-icon></button>` : ''}
    `;
  }

  connectedCallback() {
    super.connectedCallback();
    // clicar no corpo (fora do menu) → tocar
    this.addEventListener('click', (e) => {
      if (e.target.closest('.song-menu')) return;
      this.#emit('syn:song:play', { path: this.vm && this.vm.path });
    });
  }
}

customElements.define('syn-song-card', SynSongCard);

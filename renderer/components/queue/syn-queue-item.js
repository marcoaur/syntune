// <syn-queue-item> — item do painel de fila (categoria 'song'/queue). Início da Fase D.
// Light-DOM (reusa .queue-item CSS) + VM (title/artist/src/coverKnown/current). Emite
// syn:queue:jump (tocar este) / syn:queue:remove / syn:queue:cover (erro de capa → renderer
// atualiza coverState). Reorder por drag fica no item (handlers no host, sobrevivem ao render).
import { LitElement, html } from 'lit';
import '../control/syn-icon.js';

export class SynQueueItem extends LitElement {
  static properties = {
    vm: { attribute: false },   // { path, title, artist, src, coverKnown, current }
    t: { attribute: false },
    _cover: { state: true },    // 'ok' | 'none'
  };

  createRenderRoot() { return this; }

  constructor() {
    super();
    this.vm = null;
    this.t = (k) => k;
    this._cover = 'ok';
  }

  willUpdate(changed) {
    if (changed.has('vm') && this.vm) this._cover = this.vm.coverKnown === false ? 'none' : 'ok';
  }

  updated() {
    const vm = this.vm || {};
    this.classList.add('queue-item');
    this.classList.toggle('current', !!vm.current);
  }

  #emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail })); }
  #onErr() { this._cover = 'none'; this.#emit('syn:queue:cover', { path: this.vm.path, ok: false }); }

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('click', (e) => { if (e.target.closest('.qi-remove')) return; this.#emit('syn:queue:jump', { path: this.vm && this.vm.path }); });
  }

  render() {
    const vm = this.vm;
    if (!vm) return html``;
    return html`
      <div class="qi-thumb">
        ${this._cover === 'none'
          ? '♪'
          : html`<img alt="" loading="lazy" src=${vm.src} @error=${() => this.#onErr()} />`}
      </div>
      <div class="qi-text">
        <div class="qi-title">${vm.title}</div>
        <div class="qi-artist">${vm.artist || ''}</div>
      </div>
      ${vm.current ? '' : html`<button class="qi-remove" title=${this.t('player.removeFromQueue')}
        @click=${(e) => { e.stopPropagation(); this.#emit('syn:queue:remove', { path: vm.path }); }}><syn-icon name="close"></syn-icon></button>`}
    `;
  }
}

customElements.define('syn-queue-item', SynQueueItem);

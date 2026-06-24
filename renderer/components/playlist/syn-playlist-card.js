// <syn-playlist-card> — card da grade de playlists (categoria 'playlist').
// Light-DOM (createRenderRoot → this): reusa a CSS global (.pl-card/.pl-cover/...). O collage
// de capas depende do sistema de capas do renderer (coverUrl/coverState) → vem pronto em
// `coverHtml` (props down). Emite syn:playlist:open {id} ao clicar (events up).
import { LitElement, html } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

export class SynPlaylistCard extends LitElement {
  static properties = {
    pid: { type: String },
    name: { type: String },
    sub: { type: String },
    coverHtml: { attribute: false }, // HTML do collage de capas (string, dados internos)
  };

  createRenderRoot() { return this; }

  constructor() {
    super();
    this.pid = '';
    this.name = '';
    this.sub = '';
    this.coverHtml = '';
  }

  updated() {
    this.classList.add('pl-card');
    this.setAttribute('role', 'button');
    this.tabIndex = 0;
  }

  #open() { this.dispatchEvent(new CustomEvent('syn:playlist:open', { bubbles: true, composed: true, detail: { id: this.pid } })); }

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('click', () => this.#open());
    this.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.#open(); } });
  }

  render() {
    return html`
      <div class="pl-cover">${unsafeHTML(this.coverHtml || '')}</div>
      <div class="pl-card-name">${this.name}</div>
      <div class="pl-card-sub">${this.sub}</div>
    `;
  }
}

customElements.define('syn-playlist-card', SynPlaylistCard);

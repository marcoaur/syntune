// <syn-menu> — CAPACIDADE headless (ARCHITECTURE-V2): menu de contexto posicionado,
// acionável por qualquer um. `menu().open(anchorEl, items)`; itens descrevem AÇÕES
// (o componente trata clique/posição/fechar-fora/Esc/resize por conta própria).
// item = { label, icon?(html), danger?, onClick? } | { head } (rótulo) | { sep:true }.
// Light-DOM reusando a CSS global `.song-context`/`.ctx-*` (peça transiente, visual
// idêntico ao legado — tática leaf-migration). Portal no body via capabilities.js.
import { html } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { SyntuneElement } from '../base/syntune-element.js';

export class SynMenu extends SyntuneElement {
  static category = 'capability';
  createRenderRoot() { return this; } // reusa CSS global

  constructor() {
    super();
    this._items = [];
    this._open = false;
    this._onDoc = (e) => { if (this._open && !this.contains(e.target)) this.close(); };
    this._onKey = (e) => { if (this._open && e.key === 'Escape') { e.preventDefault(); this.close(); } };
    this._onResize = () => this.close();
  }

  /** Abre o menu ancorado em anchorEl com a lista de itens (ações). */
  open(anchorEl, items) {
    this.close();
    this._items = items || [];
    this._open = true;
    this.requestUpdate();
    this.updateComplete.then(() => {
      const m = this.querySelector('.song-context');
      if (!m || !anchorEl) return;
      const r = anchorEl.getBoundingClientRect();
      const mw = 200, mh = m.offsetHeight || 160;
      let left = r.right - mw; if (left < 8) left = 8;
      let top = r.bottom + 4; if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
      m.style.left = left + 'px'; m.style.top = top + 'px';
    });
    // adia 1 tick p/ o clique que abriu não fechar de imediato
    setTimeout(() => {
      document.addEventListener('click', this._onDoc);
      document.addEventListener('keydown', this._onKey, true);
      window.addEventListener('resize', this._onResize);
    }, 0);
  }

  close() {
    if (!this._open) return;
    this._open = false; this._items = []; this.requestUpdate();
    document.removeEventListener('click', this._onDoc);
    document.removeEventListener('keydown', this._onKey, true);
    window.removeEventListener('resize', this._onResize);
  }

  #pick(it) { this.close(); if (it.onClick) it.onClick(); }

  render() {
    if (!this._open) return html``;
    return html`<div class="song-context">
      ${this._items.map((it) => it.head != null
        ? html`<div class="ctx-head">${it.head}</div>`
        : it.sep
          ? html`<div class="ctx-sep"></div>`
          : html`<button class="ctx-item ${it.danger ? 'danger' : ''}" @click=${(e) => { e.stopPropagation(); this.#pick(it); }}>${it.icon ? unsafeHTML(it.icon) : ''}<span>${it.label}</span></button>`)}
    </div>`;
  }
}
customElements.define('syn-menu', SynMenu);

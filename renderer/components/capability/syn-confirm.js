// <syn-confirm> — CAPACIDADE headless (ARCHITECTURE-V2): diálogo de confirmação acionável
// que RETORNA valor. Substitui o `confirm()` nativo (síncrono/bloqueante) por um modal
// próprio assíncrono. Shadow DOM autossuficiente (herda tokens globais). Portal no body
// (z alto, escapa stacking-context). Trata os próprios eventos (botões/overlay/Esc).
// Uso via capabilities.js: `const ok = await confirm().ask({ message, danger });`
import { html, css } from 'lit';
import { SyntuneElement } from '../base/syntune-element.js';

export class SynConfirm extends SyntuneElement {
  static category = 'capability';
  static properties = {
    open: { type: Boolean, reflect: true },
    danger: { type: Boolean, reflect: true },
    _o: { state: true },
  };
  static styles = [css`
    :host { position: fixed; inset: 0; z-index: 120; display: none; }
    :host([open]) { display: flex; align-items: center; justify-content: center; }
    .ov { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.45); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); animation: fade 0.15s; }
    .card {
      position: relative; background: var(--card); color: var(--text);
      border-radius: var(--radius); box-shadow: var(--shadow);
      padding: 22px 24px; min-width: 300px; max-width: min(440px, 86vw);
      animation: drop 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .title { font-size: 16px; font-weight: 750; margin: 0 0 8px; }
    .msg { font-size: 13.5px; line-height: 1.5; opacity: 0.85; white-space: pre-wrap; }
    .row { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
    button { font: inherit; font-weight: 650; padding: 9px 18px; border-radius: 10px; cursor: pointer; border: none; transition: filter 0.15s, background 0.15s; }
    .cancel { background: rgba(127, 127, 127, 0.16); color: var(--text); }
    .cancel:hover { background: rgba(127, 127, 127, 0.26); }
    .ok { background: var(--accent); color: #fff; }
    .ok:hover { filter: brightness(1.08); }
    :host([danger]) .ok { background: #ff453a; }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes drop { from { transform: translateY(-8px); opacity: 0; } to { transform: none; opacity: 1; } }
  `];

  constructor() {
    super();
    this.open = false;
    this.danger = false;
    this._o = {};
    this._resolve = null;
    // Esc = cancelar (captura, vence atalhos globais). SEM Enter→confirmar (evita
    // confirmação destrutiva acidental).
    this._onKey = (e) => { if (this.open && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.#done(false); } };
  }
  connectedCallback() { super.connectedCallback(); document.addEventListener('keydown', this._onKey, true); }
  disconnectedCallback() { super.disconnectedCallback(); document.removeEventListener('keydown', this._onKey, true); }

  /** Abre o diálogo. @returns {Promise<boolean>} true=confirmou, false=cancelou */
  ask(opts = {}) {
    // se já havia um aberto, resolve o anterior como cancelado
    if (this._resolve) this.#done(false);
    this._o = opts || {};
    this.danger = !!this._o.danger;
    this.open = true;
    return new Promise((res) => { this._resolve = res; });
  }
  #done(v) { this.open = false; const r = this._resolve; this._resolve = null; if (r) r(v); }

  render() {
    if (!this.open) return html``;
    const o = this._o;
    return html`
      <div class="ov" @click=${() => this.#done(false)}></div>
      <div class="card" role="alertdialog" aria-modal="true">
        ${o.title ? html`<h2 class="title">${o.title}</h2>` : ''}
        <div class="msg">${o.message || ''}</div>
        <div class="row">
          <button class="cancel" @click=${() => this.#done(false)}>${o.cancelLabel || 'Cancel'}</button>
          <button class="ok" @click=${() => this.#done(true)}>${o.confirmLabel || 'OK'}</button>
        </div>
      </div>`;
  }
}
customElements.define('syn-confirm', SynConfirm);

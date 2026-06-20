// CONTAINER — <chord-line> · Lit
// Descobre os filhos pela categoria, orquestra pos/glow/accent + barra no updated();
// re-emite o feedback dos filhos de forma padronizada.
import { LitElement, html, css } from 'https://esm.sh/lit@3';
import './chord-mark.js';

export class ChordLine extends LitElement {
  static properties = {
    start: { type: Number }, end: { type: Number },
    current: { type: Number }, accent: { type: String },
  };
  static styles = css`
    :host { position:relative; display:block; height:26px; max-width:760px; margin:0 auto; }
    .sweep { position:absolute; left:0; bottom:1px; height:2px; width:0; border-radius:2px;
             background:linear-gradient(90deg, rgba(var(--acc),0), rgba(var(--acc),.55)); }
    .head { position:absolute; bottom:0; width:5px; height:5px; border-radius:50%;
            transform:translateX(-50%); background:rgb(var(--acc));
            box-shadow:0 0 8px 2px rgba(var(--acc),.75); }
  `;
  constructor() {
    super();
    this.start = 0; this.end = 1; this.current = 0; this.accent = '150,130,255';
    this.addEventListener('chordmark-select', (e) => this.#relay('chordline-select', e));
    this.addEventListener('chordmark-edit', (e) => this.#relay('chordline-edit', e));
  }
  get #marks() { return [...this.querySelectorAll('chord-mark')]; } // filhos da categoria
  #at(f) { return `calc(28px + ${f} * (100% - 56px))`; }
  updated() {
    this.style.setProperty('--acc', this.accent);
    const span = Math.max(0.1, this.end - this.start), cur = this.current;
    for (const m of this.#marks) {
      m.accent = this.accent;
      m.pos = Math.min(1, Math.max(0, (m.time - this.start) / span));
      m.glow = cur >= m.time ? Math.max(0, 1 - (cur - m.time) / 1.6) : 0;
    }
    const p = Math.min(1, Math.max(0, (cur - this.start) / span));
    this.renderRoot.querySelector('.sweep').style.width = this.#at(p);
    this.renderRoot.querySelector('.head').style.left = this.#at(p);
  }
  #relay(type, e) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, detail: e.detail }));
  }
  render() {
    return html`<div class="sweep"></div><div class="head"></div><slot></slot>`;
  }
}
customElements.define('chord-line', ChordLine);

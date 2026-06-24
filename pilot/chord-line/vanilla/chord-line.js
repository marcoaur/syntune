// CONTAINER — <chord-line> · Vanilla Custom Element (0 dependências)
// Entende os filhos pela categoria (tag chord-mark), orquestra pos/glow/accent deles e a
// barra; re-emite o feedback dos filhos de forma padronizada pro próprio pai.
import './chord-mark.js';

export class ChordLine extends HTMLElement {
  static get observedAttributes() { return ['start', 'end', 'current', 'accent']; }
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>
        :host { position:relative; display:block; height:26px; max-width:760px; margin:0 auto; }
        .sweep { position:absolute; left:0; bottom:1px; height:2px; width:0; border-radius:2px;
                 background:linear-gradient(90deg, rgba(var(--acc),0), rgba(var(--acc),.55)); }
        .head { position:absolute; bottom:0; width:5px; height:5px; border-radius:50%;
                transform:translateX(-50%); background:rgb(var(--acc));
                box-shadow:0 0 8px 2px rgba(var(--acc),.75); }
      </style>
      <div class="sweep"></div><div class="head"></div><slot></slot>`;
    this._sweep = this.shadowRoot.querySelector('.sweep');
    this._head = this.shadowRoot.querySelector('.head');
    // ouve o feedback padronizado dos filhos e RE-EMITE pro pai do chord-line
    this.addEventListener('chordmark-select', (e) => this._relay('chordline-select', e));
    this.addEventListener('chordmark-edit', (e) => this._relay('chordline-edit', e));
  }
  get _marks() { return [...this.querySelectorAll('chord-mark')]; } // filhos da categoria
  attributeChangedCallback() { this._sync(); }
  connectedCallback() { this._sync(); }
  _at(f) { return `calc(28px + ${f} * (100% - 56px))`; }
  _sync() {
    const start = +this.getAttribute('start') || 0;
    const end = +this.getAttribute('end') || 1;
    const cur = +this.getAttribute('current') || 0;
    const acc = this.getAttribute('accent') || '150,130,255';
    this.style.setProperty('--acc', acc);
    const span = Math.max(0.1, end - start);
    for (const m of this._marks) {
      m.accent = acc;
      m.pos = Math.min(1, Math.max(0, (m.time - start) / span));
      m.glow = cur >= m.time ? Math.max(0, 1 - (cur - m.time) / 1.6) : 0;
    }
    const p = Math.min(1, Math.max(0, (cur - start) / span));
    this._sweep.style.width = this._at(p);
    this._head.style.left = this._at(p);
  }
  _relay(type, e) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, detail: e.detail }));
  }
}
customElements.define('chord-line', ChordLine);

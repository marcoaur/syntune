// FILHO — <chord-mark> · Vanilla Custom Element (0 dependências)
// Configurável por params (label/time/pos/glow/accent), idempotente (render puro a partir
// das props), feedback padronizado pra cima (chordmark-select / chordmark-edit).
export class ChordMark extends HTMLElement {
  // atributo → propriedade (no vanilla isso é manual; Lit/Atomico fazem sozinhos)
  static get observedAttributes() { return ['label', 'time', 'accent']; }
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>
        :host { position:absolute; top:0; cursor:pointer; white-space:nowrap;
                font:800 13px/1 system-ui; will-change:color,transform; }
      </style><span></span>`;
    this._span = this.shadowRoot.querySelector('span');
    this._pos = 0; this._glow = 0; this._accent = '150,130,255'; this._time = 0;
    this.addEventListener('click', () => this._emit('chordmark-select'));
    this.addEventListener('dblclick', () => this._emit('chordmark-edit'));
  }
  attributeChangedCallback(name, _old, val) { this[name] = val; } // delega aos setters
  // --- params (entrada) ---
  set label(v) { this._span.textContent = v ?? ''; }
  get label() { return this._span.textContent; }
  set time(v) { this._time = +v || 0; }
  get time() { return this._time; }
  set accent(v) { this._accent = v || '150,130,255'; this._paint(); }
  set pos(v) { this._pos = +v || 0; this.style.left = `calc(28px + ${this._pos} * (100% - 56px))`; }
  set glow(v) { this._glow = +v || 0; this._paint(); }
  // --- render idempotente da cor/escala (depende só de glow/accent) ---
  _paint() {
    const a = this._accent, g = this._glow;
    this.style.color = `rgba(${a},${(0.72 + 0.28 * g).toFixed(3)})`;
    this.style.textShadow = g > 0.02 ? `0 0 ${(12 * g).toFixed(1)}px rgba(${a},${(0.6 * g).toFixed(3)})` : 'none';
    this.style.transform = `translateX(-50%) scale(${(1 + 0.16 * g).toFixed(3)})`;
  }
  // --- feedback padronizado (sobe, atravessa Shadow DOM) ---
  _emit(type) {
    this.dispatchEvent(new CustomEvent(type, {
      bubbles: true, composed: true, detail: { time: this._time, label: this.label }
    }));
  }
}
customElements.define('chord-mark', ChordMark);

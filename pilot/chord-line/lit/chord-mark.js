// FILHO — <chord-mark> · Lit
// Props reativas (idempotente: render deriva só das props). Cor/posição via style no
// updated() p/ não re-templatar a 60fps. Feedback padronizado pra cima.
import { LitElement, html, css } from 'https://esm.sh/lit@3';

export class ChordMark extends LitElement {
  static properties = {
    label: { type: String }, time: { type: Number },
    pos: { type: Number }, glow: { type: Number }, accent: { type: String },
  };
  static styles = css`
    :host { position:absolute; top:0; cursor:pointer; white-space:nowrap;
            font:800 13px/1 system-ui; will-change:color,transform; }
  `;
  constructor() {
    super();
    this.label = ''; this.time = 0; this.pos = 0; this.glow = 0; this.accent = '150,130,255';
  }
  #emit(type) {
    this.dispatchEvent(new CustomEvent(type, {
      bubbles: true, composed: true, detail: { time: this.time, label: this.label },
    }));
  }
  updated() {
    const a = this.accent, g = this.glow;
    this.style.left = `calc(28px + ${this.pos} * (100% - 56px))`;
    this.style.color = `rgba(${a},${(0.72 + 0.28 * g).toFixed(3)})`;
    this.style.textShadow = g > 0.02 ? `0 0 ${(12 * g).toFixed(1)}px rgba(${a},${(0.6 * g).toFixed(3)})` : 'none';
    this.style.transform = `translateX(-50%) scale(${(1 + 0.16 * g).toFixed(3)})`;
  }
  render() {
    return html`<span
      @click=${() => this.#emit('chordmark-select')}
      @dblclick=${() => this.#emit('chordmark-edit')}
    >${this.label}</span>`;
  }
}
customElements.define('chord-mark', ChordMark);

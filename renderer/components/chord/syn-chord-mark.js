// <syn-chord-mark> — FOLHA (arquétipo A). Um acorde posicionado no tempo.
// Contrato §1: configurável por params (label/time), idempotente (render deriva só das
// props), feedback up padronizado (syn:chord:*). A "engrenagem" é dele: sabe se desenhar,
// reagir ao destaque e avisar quando clicado — não conhece pai nem avô.
//
// Hot-path §1.6: o brilho/posição NÃO entram em render() por frame. O container escreve
// as CSS custom properties --syn-mark-glow / --syn-mark-acc e o `left` no host; a cor,
// sombra e escala DERIVAM em CSS. Assim o pai anima a 60fps sem re-templatar a folha.
import { html, css } from 'lit';
import { SyntuneElement } from '../base/syntune-element.js';

export class SynChordMark extends SyntuneElement {
  static category = 'chord';

  static properties = {
    label: { type: String },
    time: { type: Number },
  };

  static styles = [
    ...SyntuneElement.styles,
    css`
      :host {
        position: absolute; top: 0;
        --syn-mark-glow: 0;                 /* 0..1, escrito pelo container por frame */
        --syn-mark-acc: var(--syn-accent);  /* rgb triplet do destaque */
        transform: translateX(-50%) scale(calc(1 + 0.16 * var(--syn-mark-glow)));
        will-change: transform, color;
      }
      button {
        appearance: none; border: 0; padding: 0 2px; margin: 0; background: none;
        cursor: pointer; white-space: nowrap; font: 800 13px/1 var(--syn-font);
        color: rgba(var(--syn-mark-acc), calc(0.72 + 0.28 * var(--syn-mark-glow)));
        text-shadow: 0 0 calc(12px * var(--syn-mark-glow)) rgba(var(--syn-mark-acc), calc(0.6 * var(--syn-mark-glow)));
        transition: none; /* posição/brilho são imperativos; sem transição por frame */
      }
      @media (prefers-reduced-motion: reduce) {
        :host { transform: translateX(-50%); }
      }
    `,
  ];

  constructor() {
    super();
    this.label = '';
    this.time = 0;
  }

  #emit(name) { this.emit(name, { time: this.time, label: this.label }); }

  render() {
    // botão = acessível por teclado de graça (Enter/Espaço = click → select).
    return html`<button
      part="chip"
      title=${this.label}
      aria-label=${`Acorde ${this.label} em ${this.time.toFixed(1)}s`}
      @click=${(e) => { e.stopPropagation(); this.#emit('syn:chord:select'); }}
      @dblclick=${(e) => { e.stopPropagation(); this.#emit('syn:chord:edit'); }}
    >${this.label}</button>`;
  }
}

customElements.define('syn-chord-mark', SynChordMark);

// <syn-range> — FOLHA (arquétipo A), categoria 'control'. Slider param value/min/max/step.
// Usa <input type=range> nativo no shadow → acessibilidade e teclado (setas) de graça.
// Idempotente (render deriva das props); emite syn:control:change {value} ao mover.
import { html, css } from 'lit';
import { SyntuneElement } from '../base/syntune-element.js';

export class SynRange extends SyntuneElement {
  static category = 'control';

  static properties = {
    value: { type: Number },
    min: { type: Number },
    max: { type: Number },
    step: { type: Number },
    disabled: { type: Boolean, reflect: true },
    vertical: { type: Boolean, reflect: true }, // EQ usa sliders verticais
    label: { type: String },
  };

  static styles = [
    ...SyntuneElement.styles,
    css`
      :host { display: block; }
      input[type="range"] {
        -webkit-appearance: none; appearance: none; width: 100%; height: 6px; margin: 8px 0;
        /* track NEUTRO (cinza) p/ ser visível em qualquer fundo — não depende da paleta/--accent */
        border-radius: 999px; background: rgba(127, 127, 127, 0.45); cursor: pointer;
      }
      input[type="range"]:disabled { opacity: 0.45; cursor: not-allowed; }
      input[type="range"]::-webkit-slider-thumb {
        -webkit-appearance: none; appearance: none; width: 15px; height: 15px; border-radius: 50%;
        background: rgb(var(--syn-accent)); border: 0; cursor: pointer;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
      }
      input[type="range"]::-moz-range-thumb {
        width: 15px; height: 15px; border-radius: 50%; background: rgb(var(--syn-accent));
        border: 0; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
      }
      /* Vertical (EQ): Chromium recente orienta range por writing-mode; rtl = mínimo embaixo. */
      :host([vertical]) input[type="range"] {
        writing-mode: vertical-lr; direction: rtl; width: 6px; height: 110px; margin: 0;
      }
    `,
  ];

  constructor() {
    super();
    this.value = 0;
    this.min = 0;
    this.max = 100;
    this.step = 1;
    this.disabled = false;
    this.label = '';
  }

  #onInput(e) {
    this.value = Number(e.target.value);
    this.emit('syn:control:change', { value: this.value });
  }

  render() {
    return html`<input
      type="range"
      part="input"
      .value=${String(this.value)}
      min=${this.min}
      max=${this.max}
      step=${this.step}
      ?disabled=${this.disabled}
      aria-label=${this.label || 'slider'}
      @input=${(e) => this.#onInput(e)}
    />`;
  }
}

customElements.define('syn-range', SynRange);

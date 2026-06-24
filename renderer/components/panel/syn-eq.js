// <syn-eq> — painel do equalizador (categoria 'panel'). PRESENTACIONAL: o grafo Web Audio
// fica no renderer/PlayerService; aqui só os controles. Aplica a tática (container que usa
// folhas): compõe syn-switch (liga/desliga) + 6× syn-range vertical (bandas).
// Param `gains` (6 dB) / `enabled`. Emite: syn:eq:change {gains}, syn:eq:toggle {enabled}.
import { html, css } from 'lit';
import { SyntuneElement } from '../base/syntune-element.js';
import { ContainerMixin } from '../base/container-mixin.js';
import { EQ_BANDS } from '../../modules/constants.js';
import '../control/syn-range.js';
import '../control/syn-switch.js';

const EQ_MIN = -12;
const EQ_MAX = 12;

export class SynEq extends ContainerMixin(SyntuneElement) {
  static category = 'panel';

  static properties = {
    gains: { attribute: false },   // number[6] (dB)
    enabled: { type: Boolean },
    flatLabel: { type: String },   // rótulo i18n do botão "zerar" (events down)
    bare: { type: Boolean },       // só as bandas (sem head/toggle/flat) — p/ embutir em painel legado
  };

  static styles = [
    ...SyntuneElement.styles,
    css`
      :host { display: block; }
      .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
      .title { font: 700 13px/1 var(--syn-font); }
      .bands { display: flex; gap: 10px; }
      .band { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; }
      .band-val { font: 600 10px/1 var(--syn-font); opacity: 0.7; min-height: 11px; }
      .band-label { font: 600 11px/1 var(--syn-font); opacity: 0.8; }
      .actions { margin-top: 12px; display: flex; justify-content: flex-end; }
      .flat { appearance: none; border: 0; cursor: pointer; font: 600 12px/1 var(--syn-font);
              color: var(--syn-fg); background: rgba(var(--syn-accent), 0.16);
              border-radius: var(--syn-radius); padding: 6px 12px; }
    `,
  ];

  constructor() {
    super();
    this.gains = [0, 0, 0, 0, 0, 0];
    this.enabled = false;
    this.flatLabel = 'Zerar';
  }

  #setBand(i, value) {
    const next = this.gains.slice();
    next[i] = value;
    this.gains = next;
    this.emit('syn:eq:change', { gains: next });
  }

  #flat() {
    this.gains = EQ_BANDS.map(() => 0);
    this.emit('syn:eq:change', { gains: this.gains });
  }

  render() {
    return html`
      ${this.bare ? '' : html`
        <div class="head">
          <span class="title">EQ</span>
          <syn-switch
            .checked=${this.enabled}
            @syn:control:change=${(e) => { this.enabled = e.detail.checked; this.emit('syn:eq:toggle', { enabled: this.enabled }); }}
          ></syn-switch>
        </div>`}
      <div class="bands">
        ${EQ_BANDS.map((b, i) => html`
          <div class="band">
            <span class="band-val">${(this.gains[i] > 0 ? '+' : '') + this.gains[i]}</span>
            <syn-range
              vertical
              .value=${this.gains[i]}
              .min=${EQ_MIN}
              .max=${EQ_MAX}
              .step=${1}
              label=${`Banda ${b.label}Hz`}
              @syn:control:change=${(e) => this.#setBand(i, e.detail.value)}
            ></syn-range>
            <span class="band-label">${b.label}</span>
          </div>
        `)}
      </div>
      ${this.bare ? '' : html`
        <div class="actions">
          <button class="flat" @click=${() => this.#flat()}>${this.flatLabel}</button>
        </div>`}
    `;
  }
}

customElements.define('syn-eq', SynEq);

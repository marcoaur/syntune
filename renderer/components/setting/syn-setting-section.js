// <syn-setting-section> — item de accordion (categoria 'setting'). Cabeçalho clicável que
// abre/fecha o corpo (slot). Compõe a folha syn-icon (chevron) — aplica a tática: container
// que USA as folhas prontas. Param `open`; emite syn:setting:toggle {open}. A11y: o header é
// button com aria-expanded; o corpo é region; respeita prefers-reduced-motion.
import { html, css } from 'lit';
import { SyntuneElement } from '../base/syntune-element.js';
import '../control/syn-icon.js';

export class SynSettingSection extends SyntuneElement {
  static category = 'setting';

  static properties = {
    open: { type: Boolean, reflect: true },
    heading: { type: String },
  };

  static styles = [
    ...SyntuneElement.styles,
    css`
      :host { display: block; border-bottom: 1px solid rgba(127, 127, 127, 0.18); }
      .head {
        display: flex; align-items: center; justify-content: space-between; width: 100%;
        padding: 12px 4px; background: none; border: 0; cursor: pointer; color: inherit;
        font: 600 14px/1.2 var(--syn-font); text-align: left;
      }
      .chev { transition: transform 0.2s ease; opacity: 0.7; }
      :host([open]) .chev { transform: rotate(90deg); }
      .body { overflow: hidden; max-height: 0; transition: max-height 0.22s ease; }
      :host([open]) .body { max-height: 1000px; }
      .body-inner { padding: 4px 4px 14px; }
      @media (prefers-reduced-motion: reduce) {
        .chev, .body { transition: none; }
      }
    `,
  ];

  constructor() {
    super();
    this.open = false;
    this.heading = '';
  }

  #toggle() {
    this.open = !this.open;
    this.emit('syn:setting:toggle', { open: this.open });
  }

  render() {
    return html`
      <button class="head" aria-expanded=${this.open ? 'true' : 'false'} @click=${() => this.#toggle()}>
        <span>${this.heading}</span>
        <syn-icon class="chev" name="chevron" style="font-size:14px"></syn-icon>
      </button>
      <div class="body" role="region" ?inert=${!this.open}>
        <div class="body-inner"><slot></slot></div>
      </div>
    `;
  }
}

customElements.define('syn-setting-section', SynSettingSection);

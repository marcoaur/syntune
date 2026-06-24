// <syn-icon> — FOLHA (arquétipo A), categoria 'control'. Renderiza um SVG do conjunto
// ICONS (renderer/modules/icons.js) pelo nome. Dados puros, sem service, idempotente.
// Herda a cor via currentColor (os SVGs usam stroke/fill currentColor) e dimensiona por 1em.
import { html, css } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { SyntuneElement } from '../base/syntune-element.js';
import { ICONS } from '../../modules/icons.js';

export class SynIcon extends SyntuneElement {
  static category = 'control';

  static properties = {
    name: { type: String },   // chave em ICONS (ex.: 'play', 'close')
    label: { type: String },  // se setado, vira ícone acessível (role=img); senão decorativo
  };

  static styles = [
    ...SyntuneElement.styles,
    css`
      :host { display: inline-flex; width: 1em; height: 1em; line-height: 0; color: inherit; }
      svg { width: 100%; height: 100%; display: block; }
    `,
  ];

  constructor() {
    super();
    this.name = '';
    this.label = '';
  }

  render() {
    // ICONS é tabela interna imutável (sem input do usuário) → unsafeHTML é seguro aqui.
    const svg = ICONS[this.name] || '';
    return this.label
      ? html`<span role="img" aria-label=${this.label}>${unsafeHTML(svg)}</span>`
      : html`${unsafeHTML(svg)}`;
  }
}

customElements.define('syn-icon', SynIcon);

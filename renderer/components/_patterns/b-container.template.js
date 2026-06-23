// ARQUÉTIPO B — CONTAINER. Entende filhos por categoria; props down; relê e re-emite up.
// Provado em: chord/syn-chord-line.js. Não conhece o avô — só ouve filhos e sobe pro pai.
import { html, css } from 'lit';
import { SyntuneElement } from '../base/syntune-element.js';
import { ContainerMixin } from '../base/container-mixin.js';

export class SynExemploContainer extends ContainerMixin(SyntuneElement) {
  static category = 'panel';

  static properties = {
    items: { attribute: false }, // dados → filhos (props down)
  };

  static styles = [...SyntuneElement.styles, css`:host { display: block; }`];

  constructor() {
    super();
    this.items = [];
    // events up: relê o feedback do filho e re-emite padronizado pro próprio pai.
    this.addEventListener('syn:control:change', (e) => {
      this.emit('syn:panel:change', e.detail);
    });
  }

  // filhos em shadow (data-driven) → query no renderRoot; ou childrenOf(cat) p/ light DOM.
  get #children() { return [...this.renderRoot.querySelectorAll('syn-exemplo-folha')]; }

  updated() {
    // PROPS DOWN estáticas: derive das props, não por frame.
    for (const c of this.#children) { /* c.algumaProp = ... */ }
  }

  render() {
    return html`${(this.items || []).map((it) => html`
      <syn-exemplo-folha .value=${it.label}></syn-exemplo-folha>
    `)}`;
  }
}

customElements.define('syn-exemplo-container', SynExemploContainer);

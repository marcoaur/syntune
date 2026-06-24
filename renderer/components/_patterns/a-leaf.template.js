// ARQUÉTIPO A — FOLHA. Param→render puro + emit(); sem service. Copie e renomeie.
// Provado em: chord/syn-chord-mark.js. Visual hot (brilho/posição) via CSS var setada
// pelo container — NÃO entra em render() por frame.
import { html, css } from 'lit';
import { SyntuneElement } from '../base/syntune-element.js';

export class SynExemploFolha extends SyntuneElement {
  static category = 'control'; // troque pela categoria real

  static properties = {
    value: { type: String },
  };

  static styles = [
    ...SyntuneElement.styles,
    css`:host { display: inline-block; }`,
  ];

  constructor() {
    super();
    this.value = '';
  }

  render() {
    // botão = acessível por teclado de graça; emite feedback padronizado pra cima.
    return html`<button
      part="root"
      @click=${() => this.emit('syn:control:change', { value: this.value })}
    >${this.value}</button>`;
  }
}

customElements.define('syn-exemplo-folha', SynExemploFolha);

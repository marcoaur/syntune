// ARQUÉTIPO C — CONECTADO. Lê um service via @lit/context e dispara intents (chama o
// service). Provado em: chord/syn-chord-line.js (consome playerContext). Sem decorators
// (projeto vanilla-JS por ora): usa ContextConsumer.
import { html, css } from 'lit';
import { ContextConsumer } from '@lit/context';
import { SyntuneElement } from '../base/syntune-element.js';
import { libraryContext } from '../../services/contexts.js';

export class SynExemploConectado extends SyntuneElement {
  static category = 'panel';

  static styles = [...SyntuneElement.styles, css`:host { display: block; }`];

  constructor() {
    super();
    this._lib = new ContextConsumer(this, {
      context: libraryContext,
      subscribe: true,
      callback: () => this.requestUpdate(), // estado do service mudou → re-render
    });
  }

  #reload() {
    const lib = this._lib.value;
    if (lib) lib.reload(); // intent: chama o service (não muta estado direto)
  }

  render() {
    const lib = this._lib.value;
    const songs = (lib && lib.songs) || [];
    return html`
      <button @click=${() => this.#reload()}>recarregar</button>
      <span>${songs.length} faixas</span>
    `;
  }
}

customElements.define('syn-exemplo-conectado', SynExemploConectado);

// ARQUÉTIPO D — HOT-PATH. rAF próprio escrevendo style/canvas direto; NUNCA re-render por
// frame (§1.6 / §4). Provado em: chord/syn-chord-line.js (sweep/brilho). render() só monta
// a casca; o controller anima.
import { html, css } from 'lit';
import { SyntuneElement } from '../base/syntune-element.js';
import { RafController } from '../controllers/raf-controller.js';
import { MediaTimeController } from '../controllers/media-time-controller.js';

export class SynExemploHotpath extends SyntuneElement {
  static category = 'panel';

  static styles = [
    ...SyntuneElement.styles,
    css`:host { display: block; position: relative; height: 4px; }
        .bar { position: absolute; left: 0; bottom: 0; height: 100%; width: 0;
               background: rgb(var(--syn-accent)); }`,
  ];

  constructor() {
    super();
    this._time = new MediaTimeController(this, null); // .setPlayer(svc) quando o player chegar
    this._raf = new RafController(this, () => this.#frame());
  }

  connectedCallback() { super.connectedCallback(); this._raf.start(); }

  #frame() {
    const t = this._time.currentTime;     // leitura ao vivo, barata
    const bar = this.renderRoot.querySelector('.bar');
    if (bar) bar.style.width = `${(t % 10) * 10}%`; // escrita direta — sem requestUpdate
  }

  render() { return html`<div class="bar"></div>`; } // só a casca
}

customElements.define('syn-exemplo-hotpath', SynExemploHotpath);

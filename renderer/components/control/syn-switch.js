// <syn-switch> — FOLHA (arquétipo A), categoria 'control'. Toggle on/off acessível.
// Valida que o padrão (template A) generaliza p/ uma ilha DIFERENTE da de acordes
// (FRONTEND-MIGRATION.md §0 Passo 2). Sem service: só param→render + emit().
//
// Contrato §1: configurável (`checked`/`disabled`), idempotente (render deriva só das
// props), feedback up padronizado (`syn:control:change`, bubbles+composed). A engrenagem é
// dele: alterna o próprio estado, reflete no ARIA e avisa pra cima — não conhece o pai.
import { html, css } from 'lit';
import { SyntuneElement } from '../base/syntune-element.js';

export class SynSwitch extends SyntuneElement {
  static category = 'control';

  static properties = {
    checked: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
  };

  static styles = [
    ...SyntuneElement.styles,
    css`
      :host { display: inline-flex; }
      button {
        --w: 38px; --h: 22px; --p: 3px;
        position: relative; width: var(--w); height: var(--h); padding: 0; border: 0;
        border-radius: 999px; cursor: pointer;
        background: rgba(var(--syn-accent), 0.22);
        transition: background 0.18s ease;
      }
      button[aria-checked="true"] { background: rgb(var(--syn-accent)); }
      button:disabled { opacity: 0.45; cursor: not-allowed; }
      .thumb {
        position: absolute; top: var(--p); left: var(--p);
        width: calc(var(--h) - 2 * var(--p)); height: calc(var(--h) - 2 * var(--p));
        border-radius: 50%; background: #fff;
        transition: transform 0.18s ease;
      }
      button[aria-checked="true"] .thumb {
        transform: translateX(calc(var(--w) - var(--h)));
      }
      @media (prefers-reduced-motion: reduce) {
        button, .thumb { transition: none; }
      }
    `,
  ];

  constructor() {
    super();
    this.checked = false;
    this.disabled = false;
  }

  #toggle() {
    if (this.disabled) return;
    this.checked = !this.checked;            // estado próprio (param) → render idempotente
    this.emit('syn:control:change', { checked: this.checked }); // feedback up; pai pode sobrescrever
  }

  render() {
    // button[role=switch] = teclado (Espaço/Enter) e foco nativos + semântica de switch.
    return html`<button
      role="switch"
      part="track"
      aria-checked=${this.checked ? 'true' : 'false'}
      ?disabled=${this.disabled}
      @click=${() => this.#toggle()}
    ><span class="thumb" part="thumb"></span></button>`;
  }
}

customElements.define('syn-switch', SynSwitch);

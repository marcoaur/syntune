// <syn-sync-badge> — FOLHA (arquétipo A), categoria 'control'. Pílula de estado de
// sincronização de uma faixa: 'synced' (✓ verde) ou 'unsynced' (○ esmaecido). Param puro,
// sem service. O texto acessível vem por `label` (i18n resolvido pelo pai → events down).
import { html, css } from 'lit';
import { SyntuneElement } from '../base/syntune-element.js';

export class SynSyncBadge extends SyntuneElement {
  static category = 'control';

  static properties = {
    status: { type: String, reflect: true }, // 'synced' | 'unsynced'
    label: { type: String },                  // título/aria (texto traduzido)
  };

  static styles = [
    ...SyntuneElement.styles,
    css`
      :host { display: inline-flex; }
      .badge {
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
        font: 700 11px/1 var(--syn-font);
        background: rgba(127, 127, 127, 0.18); color: var(--syn-fg);
      }
      :host([status="synced"]) .badge { background: rgba(52, 199, 89, 0.18); color: #2ea043; }
    `,
  ];

  constructor() {
    super();
    this.status = 'unsynced';
    this.label = '';
  }

  render() {
    const synced = this.status === 'synced';
    return html`<span class="badge" role="img" aria-label=${this.label || this.status} title=${this.label}>
      ${synced ? '✓' : '○'}
    </span>`;
  }
}

customElements.define('syn-sync-badge', SynSyncBadge);

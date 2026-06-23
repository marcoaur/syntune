// <syn-loading> — CAPACIDADE headless (ARCHITECTURE-V2): overlay de "carregando" acionável
// por qualquer um. Não é uma view — é trabalho de escopo (mostrar/ocultar). Shadow DOM
// autossuficiente: estilos próprios, herda só os tokens globais (--card/--accent/--shadow…
// furam o shadow por serem propriedades herdadas). Singleton montado no body via
// capabilities.js: `import { loading } from '../capabilities.js'; loading().show('…')`.
import { html, css } from 'lit';
import { SyntuneElement } from '../base/syntune-element.js';

export class SynLoading extends SyntuneElement {
  static category = 'capability';
  static properties = {
    open: { type: Boolean, reflect: true }, // acionador: visibilidade = estado dele
    msg: { type: String },
  };
  static styles = [css`
    :host { position: fixed; inset: 0; z-index: 95; display: none; }
    :host([open]) { display: flex; justify-content: center; align-items: center; padding-top: var(--tb-height, 0); }
    .ov { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.28); -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px); }
    .card {
      position: relative; background: var(--card); border-radius: var(--radius);
      box-shadow: var(--shadow); padding: 22px 26px; min-width: 220px; max-width: 80vw;
      display: flex; flex-direction: column; align-items: center; gap: 14px;
      animation: drop 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .spin { width: 32px; height: 32px; border-radius: 50%; border: 3px solid rgba(127, 127, 127, 0.25); border-top-color: var(--accent); animation: spin 0.8s linear infinite; }
    .msg { font-size: 13px; color: var(--text); text-align: center; line-height: 1.4; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes drop { from { transform: translateY(-8px); opacity: 0; } to { transform: none; opacity: 1; } }
  `];

  constructor() { super(); this.open = false; this.msg = ''; }

  show(msg) { this.msg = msg || ''; this.open = true; }
  hide() { this.open = false; }

  render() {
    if (!this.open) return html``;
    return html`<div class="ov"></div><div class="card"><div class="spin"></div><div class="msg">${this.msg}</div></div>`;
  }
}
customElements.define('syn-loading', SynLoading);

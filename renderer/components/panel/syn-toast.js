// <syn-toast> — CONECTADO (arquétipo C), categoria 'panel'. Consome o ToastService via
// @lit/context e renderiza o toast corrente. A "engrenagem é dele": assina o serviço,
// mostra a mensagem com ícone por tipo e se auto-esconde (3200ms + 260ms de saída),
// espelhando o toast() legado. Sem prop de entrada — o estado vem do serviço injetado.
import { html, css } from 'lit';
import { ContextConsumer } from '@lit/context';
import { SyntuneElement } from '../base/syntune-element.js';
import { toastContext } from '../../services/contexts.js';

const DWELL = 3200; // ms visível
const LEAVE = 260;  // ms da animação de saída

export class SynToast extends SyntuneElement {
  static category = 'panel';

  static properties = {
    _toast: { state: true },   // { msg, type } corrente
    _leaving: { state: true },
  };

  static styles = [
    ...SyntuneElement.styles,
    css`
      :host {
        position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
        z-index: 9999; pointer-events: none;
      }
      .toast {
        display: inline-flex; align-items: center; gap: 8px;
        padding: 10px 16px; border-radius: 999px; font: 600 13px/1.2 var(--syn-font);
        color: var(--syn-fg); background: rgba(40, 40, 48, 0.96);
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
        animation: syn-toast-in 0.22s ease;
      }
      .toast.success { color: #2ea043; }
      .toast.error { color: #ff6b6b; }
      .ic { font-weight: 800; }
      .leaving { animation: syn-toast-out 0.26s ease forwards; }
      @keyframes syn-toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; } }
      @keyframes syn-toast-out { to { opacity: 0; transform: translateY(8px); } }
      @media (prefers-reduced-motion: reduce) {
        .toast, .leaving { animation: none; }
      }
    `,
  ];

  constructor() {
    super();
    this._toast = null;
    this._leaving = false;
    this._unsub = null;
    this._t1 = 0;
    this._t2 = 0;
    // Conectado: o ToastService chega via context (provido no <syn-app-root>).
    this._svc = new ContextConsumer(this, {
      context: toastContext,
      subscribe: true,
      callback: (svc) => this.#bind(svc),
    });
  }

  #bind(svc) {
    if (this._unsub) { this._unsub(); this._unsub = null; }
    if (!svc) return;
    this._unsub = svc.onChange((e) => this.#show(e.detail || svc.current));
  }

  #show(t) {
    if (!t || !t.msg) return;
    this._toast = t;
    this._leaving = false;
    clearTimeout(this._t1);
    clearTimeout(this._t2);
    this._t1 = setTimeout(() => {
      this._leaving = true;
      this._t2 = setTimeout(() => { this._toast = null; this._leaving = false; }, LEAVE);
    }, DWELL);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._unsub) this._unsub();
    clearTimeout(this._t1);
    clearTimeout(this._t2);
  }

  render() {
    const t = this._toast;
    if (!t) return html``;
    const icon = t.type === 'success' ? '✓' : (t.type === 'error' ? '!' : '♪');
    return html`<div
      class="toast ${t.type || ''} ${this._leaving ? 'leaving' : ''}"
      role="status"
      aria-live=${t.type === 'error' ? 'assertive' : 'polite'}
    ><span class="ic" aria-hidden="true">${icon}</span><span class="msg">${t.msg}</span></div>`;
  }
}

customElements.define('syn-toast', SynToast);

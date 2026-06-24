// ARQUÉTIPO E — PROVIDER/ROOT. Instancia os serviços UMA vez e os provê via ContextProvider
// p/ toda a árvore consumir. Provado em: app-root.js (<syn-app-root>). As ilhas migradas
// vivem no <slot> e enxergam todos os contexts. Normalmente só existe UM (o app-root real);
// este template serve p/ providers locais (sub-árvores com escopo próprio).
import { LitElement, html } from 'lit';
import { ContextProvider } from '@lit/context';
import { toastContext } from '../../services/contexts.js';
import { ToastService } from '../../services/toast-service.js';

export class SynExemploProvider extends LitElement {
  constructor() {
    super();
    this.services = { toast: new ToastService() };
    this._providers = [
      new ContextProvider(this, { context: toastContext, initialValue: this.services.toast }),
    ];
  }

  render() { return html`<slot></slot>`; }
}

customElements.define('syn-exemplo-provider', SynExemploProvider);

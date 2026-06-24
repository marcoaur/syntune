// <syn-app-root> — Provider raiz (contrato §2.1 / arquétipo E). Instancia os serviços
// UMA vez e os disponibiliza via @lit/context p/ toda a árvore de componentes consumir
// (@consume). Usa ContextProvider (sem decorators — projeto é vanilla-JS por ora; a
// migração p/ TS + decorators é a 2ª grande mexida, §5).
//
// Interop incremental (§2.4): cada ilha Lit é montada DENTRO de um <syn-app-root> (no
// slot), passando a conversar com o resto do app pelos mesmos serviços injetados aqui.
import { LitElement, html } from 'lit';
import { ContextProvider } from '@lit/context';
import {
  apiContext, playerContext, libraryContext, paletteContext,
  settingsContext, i18nContext, devicesContext, toastContext,
} from '../services/contexts.js';
import { PaletteService } from '../services/palette-service.js';
// Store-núcleo (Fase 3): api + biblioteca + player são SINGLETONS eager (core-store.js);
// o app-root só os re-provê via context → mesma instância que o renderer escreve.
import { coreApi, libraryStore, playerStore, devicesStore } from '../services/core-store.js';
import { SettingsService } from '../services/settings-service.js';
import { I18nService } from '../services/i18n-service.js';
import { ToastService } from '../services/toast-service.js';

export class SynAppRoot extends LitElement {
  constructor() {
    super();
    // Ordem importa: serviços que dependem da ponte recebem o ApiService.
    const api = coreApi;
    const services = {
      api,
      player: playerStore,
      library: libraryStore,
      palette: new PaletteService(),
      settings: new SettingsService(api),
      i18n: new I18nService(api),
      devices: devicesStore,
      toast: new ToastService(),
    };
    this.services = services;

    // Provê cada serviço no seu context. ContextProvider é um ReactiveController:
    // se trocarmos o valor (provider.setValue), os @consume reagem.
    this._providers = [
      new ContextProvider(this, { context: apiContext, initialValue: services.api }),
      new ContextProvider(this, { context: playerContext, initialValue: services.player }),
      new ContextProvider(this, { context: libraryContext, initialValue: services.library }),
      new ContextProvider(this, { context: paletteContext, initialValue: services.palette }),
      new ContextProvider(this, { context: settingsContext, initialValue: services.settings }),
      new ContextProvider(this, { context: i18nContext, initialValue: services.i18n }),
      new ContextProvider(this, { context: devicesContext, initialValue: services.devices }),
      new ContextProvider(this, { context: toastContext, initialValue: services.toast }),
    ];
  }

  render() {
    // Slot: as ilhas migradas vivem aqui dentro e enxergam todos os contexts.
    return html`<slot></slot>`;
  }
}

customElements.define('syn-app-root', SynAppRoot);

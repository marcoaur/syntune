// SettingsService (contrato §2.1) — get/set de config (advancedEdit, chaves, idioma,
// pasta). ESQUELETO Fase A; lê/escreve via ApiService (config:get/set no main).
import { StoreService } from './store-service.js';

export class SettingsService extends StoreService {
  /** @param {import('./api-service.js').ApiService} api */
  constructor(api) {
    super();
    this.api = api;
    /** @type {Record<string, any>} */ this.config = {};
  }
  async load() { this.config = (await this.api.getConfig()) || {}; this.emitChange(); return this.config; }
  get(key) { return this.config[key]; }
  async set(patch) {
    this.config = { ...this.config, ...patch };
    await this.api.setConfig(this.config);
    this.emitChange();
  }
}

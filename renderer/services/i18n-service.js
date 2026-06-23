// I18nService (contrato §2.1 / regra §4) — t(), idioma atual, troca de idioma. Todo
// texto dos componentes passa por aqui. ESQUELETO Fase A; o dicionário vem do main
// (i18n:get) via ApiService, espelhando o t() atual do renderer.js.
import { StoreService } from './store-service.js';

export class I18nService extends StoreService {
  /** @param {import('./api-service.js').ApiService} api */
  constructor(api) {
    super();
    this.api = api;
    /** @type {Record<string,string>} */ this.strings = {};
    this.lang = 'en';
  }
  async load() {
    const r = await this.api.getI18n();
    this.strings = (r && r.strings) || {};
    if (r && r.lang) this.lang = r.lang;
    this.emitChange();
  }
  /** @param {string} key @param {Record<string, string|number>} [vars] */
  t(key, vars) {
    let s = this.strings[key] != null ? this.strings[key] : key;
    if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
    return s;
  }
  async setLanguage(lang) { await this.api.raw.setLanguage(lang); await this.load(); }
}

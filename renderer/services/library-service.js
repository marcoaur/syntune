// LibraryService (contrato §2.1) — lista da biblioteca, reload, busca/filtro, cache de
// paleta. ESQUELETO Fase A; lógica migra do renderer.js na Fase C (syn-library).
import { StoreService } from './store-service.js';

export class LibraryService extends StoreService {
  /** @param {import('./api-service.js').ApiService} api */
  constructor(api) {
    super();
    this.api = api;
    /** @type {object[]} */ this.songs = [];
    this.query = '';
  }
  async reload() {
    this.songs = (await this.api.libraryList()) || [];
    this.emitChange();
    return this.songs;
  }
  search(q) { this.query = q || ''; this.emitChange(); }
}

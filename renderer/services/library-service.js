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
    const r = await this.api.libraryList();
    this.set('songs', (r && r.items) || []);
    return this.songs;
  }
  /** Fonte única da biblioteca: define songs + notifica assinantes (granular). */
  setSongs(items) { this.set('songs', items || []); }
  search(q) { this.set('query', q || ''); }
}

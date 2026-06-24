// PlaylistsService (store-núcleo, ARCHITECTURE-V2 §store) — fonte única das playlists
// (estado core compartilhado: grade/página/menu add-to-playlist). Persistência fica no
// config.json via ApiService; aqui só o estado em memória + notificação granular.
//
// Migração incremental: o renderer escreve via setPlaylists e mantém seu global como
// ESPELHO (subscribe). CRUD muta o array in-place (push/splice) — como o espelho e o
// store apontam pro mesmo array, ficam consistentes; o save persiste o mesmo conteúdo.
import { StoreService } from './store-service.js';

export class PlaylistsService extends StoreService {
  /** @param {import('./api-service.js').ApiService} api */
  constructor(api) {
    super();
    this.api = api;
    /** @type {object[]} */ this.playlists = [];
  }
  /** Carrega do config.json → fonte única. */
  async load() {
    try { const cfg = await this.api.getConfig(); this.set('playlists', Array.isArray(cfg.playlists) ? cfg.playlists : []); }
    catch { this.set('playlists', []); }
    return this.playlists;
  }
  setPlaylists(arr) { this.set('playlists', Array.isArray(arr) ? arr : []); }
  /** Persiste o estado atual no config.json. */
  async save() { try { await this.api.setConfig({ playlists: this.playlists }); } catch { /* ok */ } }
}

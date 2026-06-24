// core-store.js — STORE-NÚCLEO (ARCHITECTURE-V2, Fase 3). Instâncias SINGLETON eager
// do estado central compartilhado entre as views acopladas (biblioteca/playlists/
// devices/now-playing). Segue o precedente de capabilities.js: quem precisa importa o
// singleton; lifecycle independente do mount do <syn-app-root> (sem SPOF/timing).
//
// O <syn-app-root> IMPORTA estes mesmos singletons (não faz `new`), então o context
// Lit provê exatamente a mesma instância que o renderer escreve → uma fonte só.
//
// Migração incremental: o renderer ESCREVE aqui (setSongs/...) e mantém seus globais
// como ESPELHO no início; os leitores migram pro store subsistema a subsistema.
import { ApiService } from './api-service.js';
import { LibraryService } from './library-service.js';
import { PlaylistsService } from './playlists-service.js';
import { PlayerService } from './player-service.js';

/** Ponte IPC única (pass-through tipado). */
export const coreApi = new ApiService();

/** Biblioteca: fonte única de `songs`. Assinatura granular via subscribe('songs', fn). */
export const libraryStore = new LibraryService(coreApi);

/** Playlists: fonte única de `playlists`. subscribe('playlists', fn). */
export const playlistsStore = new PlaylistsService(coreApi);

/** Player: estado de reprodução (current/isPlaying/...). Eager → sempre disponível,
 *  sem depender do mount do <syn-app-root> (remove SPOF/timing dos guards do renderer). */
export const playerStore = new PlayerService();

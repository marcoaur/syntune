// DevicesService (store-núcleo, ARCHITECTURE-V2 §store) — estado de sync de dispositivos.
// Fonte única de `activeDevice` (dispositivo conectado c/ sync) e `syncedKeys` (Set das
// keys sincronizadas no dispositivo de referência). Consumido por biblioteca (badges de
// sync) e pela view de devices. Liga nos eventos device:attached/detached via renderer.
import { StoreService } from './store-service.js';

export class DevicesService extends StoreService {
  /** @param {import('./api-service.js').ApiService} api */
  constructor(api) {
    super();
    this.api = api;
    /** @type {object|null} */ this.activeDevice = null;
    /** @type {Set<string>} */ this.syncedKeys = new Set();
    /** há um dispositivo de referência → exibir badges de sync na biblioteca? */
    this.hasSyncContext = false;
    /** faixas que só existem no dispositivo — entram na lista da biblioteca. */
    this.deviceOnlySongs = [];
  }
  setActiveDevice(d) { this.set('activeDevice', d || null); }
  /** Aceita Set ou array de keys → normaliza p/ Set. */
  setSyncedKeys(keys) { this.set('syncedKeys', keys instanceof Set ? keys : new Set(keys || [])); }
  setHasSyncContext(v) { this.set('hasSyncContext', !!v); }
  setDeviceOnlySongs(arr) { this.set('deviceOnlySongs', Array.isArray(arr) ? arr : []); }
}

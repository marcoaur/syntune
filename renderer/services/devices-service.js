// DevicesService (contrato §2.1) — detecção/sync de dispositivos. ESQUELETO Fase A;
// lógica migra na Fase C (syn-devices). Liga nos eventos device:attached/detached.
import { StoreService } from './store-service.js';

export class DevicesService extends StoreService {
  /** @param {import('./api-service.js').ApiService} api */
  constructor(api) {
    super();
    this.api = api;
    /** @type {object[]} */ this.devices = [];
    /** @type {object|null} */ this.active = null;
  }
  async list() { this.devices = (await this.api.raw.devicesList()) || []; this.emitChange(); return this.devices; }
}

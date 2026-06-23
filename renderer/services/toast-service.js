// ToastService (contrato §2.1) — toast(msg, tipo). ESQUELETO Fase A; o <syn-toast>
// (Fase B) consome este serviço e renderiza. Aqui só guarda o toast corrente + notifica.
import { StoreService } from './store-service.js';

export class ToastService extends StoreService {
  constructor() {
    super();
    /** @type {{ msg: string, type: string }|null} */ this.current = null;
  }
  /** @param {string} msg @param {'info'|'success'|'error'} [type] */
  toast(msg, type = 'info') {
    this.current = { msg, type };
    this.emitChange(this.current);
  }
}

// PaletteService (contrato §2.1) — paleta/accent derivada da capa atual. ESQUELETO Fase A;
// reusa deriveBarColors/lerpPal de renderer/modules/color.js quando migrar.
import { StoreService } from './store-service.js';

export class PaletteService extends StoreService {
  constructor() {
    super();
    this.accent = '124, 92, 255'; // rgb triplet (combina com --accent global)
    /** @type {object|null} */ this.palette = null;
  }
  setAccent(rgbTriplet) { this.accent = rgbTriplet; this.emitChange(); }
}

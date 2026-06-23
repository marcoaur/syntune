// StoreService — base dos serviços de estado (contrato §2.1). Fonte única de estado,
// notifica assinantes em mudança. Componentes consomem via context; quando o estado
// muda, o provider re-provê e os @consume reagem. Aqui usamos EventTarget simples:
// services chamam this.emit() após mutar; o <app-root> ouve e re-renderiza.
export class StoreService extends EventTarget {
  /** Notifica que o estado mudou (o provider escuta p/ re-prover). */
  emitChange(detail) {
    this.dispatchEvent(new CustomEvent('change', { detail }));
  }
  /** @param {(e: CustomEvent) => void} fn @returns {() => void} cancelador */
  onChange(fn) {
    this.addEventListener('change', fn);
    return () => this.removeEventListener('change', fn);
  }

  // ---- Assinatura GRANULAR por campo (store-núcleo, ARCHITECTURE-V2 §store) ----
  // set(key,val) muta o campo e notifica SÓ quem assina aquele campo (`change:<key>`),
  // evitando re-render global quando um único campo muda. Mantém `change` global p/
  // back-compat. No-op se o valor não mudou (===) — arrays/objs novos sempre disparam.
  /** @param {string} key @param {*} value @returns {boolean} mudou? */
  set(key, value) {
    if (this[key] === value) return false;
    this[key] = value;
    this.dispatchEvent(new CustomEvent('change:' + key, { detail: value }));
    this.emitChange({ key, value });
    return true;
  }
  /** Assina um campo. fn recebe o novo valor. @returns {() => void} cancelador */
  subscribe(key, fn) {
    const h = (e) => fn(e.detail);
    this.addEventListener('change:' + key, h);
    return () => this.removeEventListener('change:' + key, h);
  }
}

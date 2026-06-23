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
}

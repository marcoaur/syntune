// ContainerMixin (contrato §1.4 / §2.2) — dá a um SyntuneElement a capacidade de:
//  - descobrir filhos por categoria (childrenOf), ignorando nós estranhos;
//  - ouvir o feedback dos filhos (onChild) e re-emitir padronizado pro próprio pai.
// Fluxo: props down (o container escreve nos filhos) / events up (relê e sobe).
//
// Uso:
//   class Foo extends ContainerMixin(SyntuneElement) { ... }
//   this.childrenOf('chord')           → [...filhos cuja static category === 'chord']
//   this.onChild('syn:chord:select', e => this.emit('syn:chordline:select', e.detail));

/**
 * @template {new (...args: any[]) => HTMLElement} T
 * @param {T} Base
 */
export const ContainerMixin = (Base) => class extends Base {
  /**
   * Filhos (em qualquer nível do light DOM) cuja `static category` casa.
   * @param {string} category
   * @returns {Element[]}
   */
  childrenOf(category) {
    return [...this.querySelectorAll('*')].filter(
      (el) => el.constructor && el.constructor.category === category
    );
  }

  /**
   * Assina um evento de filho. Como os eventos sobem (bubbles+composed), basta ouvir
   * no próprio container. Devolve uma função p/ cancelar a assinatura.
   * @param {string} name
   * @param {(e: CustomEvent) => void} handler
   * @returns {() => void}
   */
  onChild(name, handler) {
    this.addEventListener(name, handler);
    return () => this.removeEventListener(name, handler);
  }
};

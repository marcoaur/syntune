// Base de TODOS os componentes (contrato §1 / §2.2). Estende LitElement com as convenções
// do projeto: emit() padronizado (events up), `static category` p/ os containers
// reconhecerem o filho, e sharedStyles por baixo.
//
// Regras herdadas:
//  - render() deriva só de props/estado reativo (idempotente; sem efeito colateral).
//  - feedback sobe via CustomEvent `syn:<categoria>:<ação>`, bubbles + composed
//    (atravessa Shadow DOM); filho nunca chama método do pai.
import { LitElement } from 'lit';
import { sharedStyles } from '../styles/shared-styles.js';

export class SyntuneElement extends LitElement {
  // Categoria do componente (chord|lyric|song|playlist|device|setting|control|panel).
  // Subclasses sobrescrevem. Containers usam p/ descobrir filhos (ver ContainerMixin).
  static category = null;

  // Estilo compartilhado por baixo; subclasses concatenam: `static styles = [...super.styles, css`...`]`.
  static styles = [sharedStyles];

  /**
   * Emite um evento padronizado para cima. Nome no formato `syn:<categoria>:<ação>`.
   * @param {string} name  ex.: 'syn:control:change'
   * @param {*} [detail]   payload tipado do evento
   * @param {{bubbles?: boolean, composed?: boolean, cancelable?: boolean}} [opts]
   */
  emit(name, detail, opts = {}) {
    this.dispatchEvent(new CustomEvent(name, {
      bubbles: true,
      composed: true,
      cancelable: false,
      ...opts,
      detail,
    }));
  }
}

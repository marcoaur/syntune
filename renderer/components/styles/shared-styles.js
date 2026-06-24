// Estilo compartilhado (contrato §1.5 / §1.6) — tokens de design + primitivas reusáveis.
// Importado por componentes via `static styles = [sharedStyles, css`...`]`. Os tokens
// espelham as custom properties do styles.css global, migrando aos poucos p/ o Shadow DOM.
import { css } from 'lit';

// Tokens base (cores/espaços/raios). Definidos em :host p/ herdarem no Shadow DOM.
// Onde já existir a custom property no documento (styles.css), o var() a reaproveita.
export const tokens = css`
  :host {
    /* TRIPLET r,g,b (não hex): os componentes usam rgb(var(--syn-accent)) / rgba(...,a).
       O --accent global é #7c5cff (hex) → NÃO serve aqui (rgb(#hex) = inválido → transparente).
       124,92,255 é o mesmo #7c5cff em triplet. Componentes podem sobrescrever (ex.: chord
       island passa a paleta como triplet). */
    --syn-accent: 124, 92, 255;
    --syn-bg: var(--bg, #14141a);
    --syn-fg: var(--fg, #f3f3f7);
    --syn-radius: 12px;
    --syn-gap: 12px;
    --syn-font: "InterVariable", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
`;

// Primitivas de UI compartilhadas (botão, foco acessível). Cresce conforme as ilhas migram.
export const primitives = css`
  :host { font-family: var(--syn-font); color: var(--syn-fg); box-sizing: border-box; }
  *, *::before, *::after { box-sizing: inherit; }
  .syn-btn {
    appearance: none; border: 0; cursor: pointer; font: inherit;
    border-radius: var(--syn-radius); padding: 8px 14px;
    background: rgba(var(--syn-accent), 0.16); color: var(--syn-fg);
    transition: background 0.15s ease, transform 0.1s ease;
  }
  .syn-btn:hover { background: rgba(var(--syn-accent), 0.28); }
  .syn-btn:active { transform: scale(0.97); }
  :focus-visible { outline: 2px solid rgb(var(--syn-accent)); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) {
    .syn-btn { transition: none; }
  }
`;

// Conveniência: aplica tokens + primitivas de uma vez.
export const sharedStyles = [tokens, primitives];

# Como criar um componente (padrão Syntune · Lit)

> Assinado **depois** da 1ª ilha provada (karaokê de acordes, `components/chord/`).
> Todo componente novo **copia** um destes templates. Mudar arquétipo depois é caro —
> por isso só assinamos com prova rodando no app (FRONTEND-MIGRATION.md §0, Passo 3).

## Regra de ouro: a engrenagem é do componente
Tudo que o componente precisa para funcionar é **dele**: ele conhece o próprio
funcionamento. Dado o mínimo de entradas (props + serviços injetados), ele se monta,
se sincroniza e reage sozinho — **não** depende do pai para orquestrar cada detalhe nem
alcança estado global solto.

## Assinatura (contrato §1 — inegociável)
- **Arquivo:** `renderer/components/<categoria>/<nome>.js` (1 componente/arquivo).
- **Tag:** `syn-<nome>` · **Classe:** `SynNome extends SyntuneElement` (ou `ContainerMixin(SyntuneElement)`).
- **Categoria:** `static category = '<chord|lyric|song|playlist|device|setting|control|panel>'`.
- **Entradas:** só `static properties` (props reativas) **ou** serviço via `@lit/context`.
  Nunca ler estado externo direto.
- **Saídas (events up):** `this.emit('syn:<categoria>:<ação>', detailTipado)` — já vem
  `bubbles:true, composed:true` (atravessa Shadow DOM). Filho nunca chama método do pai.
- **Idempotente:** `render()` deriva **só** de props/estado reativo; **zero** efeito
  colateral em render. Efeitos vão em `updated()`/controllers.
- **Hot-path (§1.6):** nada de bindar prop a `render()` a 60fps. Use `RafController` +
  escrita de `style`/CSS var direto (ver template D e `chord/syn-chord-line.js`).
- **Estilo:** `static styles = [...SyntuneElement.styles, css\`…\`]`. Tokens via custom
  properties (`--syn-*`); nada hardcoded.

## Arquétipos (template de referência cada)
| # | Arquétipo | Template | Exemplo provado |
|---|---|---|---|
| A | **Folha** — param→render puro + `emit()`, sem service | `a-leaf.template.js` | `chord/syn-chord-mark.js` |
| B | **Container** — `childrenOf(cat)`, props down / relê+re-emite up | `b-container.template.js` | `chord/syn-chord-line.js` |
| C | **Conectado** — `@consume`/`ContextConsumer` lê service, dispara intents | `c-connected.template.js` | `chord/syn-chord-line.js` |
| D | **Hot-path** — `RafController`/`MediaTimeController`, escreve style direto | `d-hotpath.template.js` | `chord/syn-chord-line.js` |
| E | **Provider/root** — provê os contexts via `ContextProvider` | `e-provider.template.js` | `app-root.js` |

> A ilha de acordes funde B+C+D num só componente — é o caso real que validou que os
> arquétipos compõem entre si (provider → conectado → container → folha, context descendo
> e eventos subindo através do Shadow DOM).

## DoD (Definition of Done — vale p/ TODA ilha)
- [ ] **contrato §1** acima cumprido (params, idempotente, eventos, categoria).
- [ ] **a11y** — papéis/ARIA, teclado, foco, `prefers-reduced-motion`.
- [ ] **design tokens** — `--syn-*`, nada hardcoded; CSS migra do `styles.css` p/ o Shadow DOM.
- [ ] **teste** — ≥1 `*.test.js` (props→render + eventos) via `npm run test:wc`.
- [ ] **i18n** — textos via `I18nService.t()`; paridade dos 6 dicts (`check-i18n`).
- [ ] **sem regressão de perf** — lazy/`content-visibility` onde couber.
- [ ] **remove o equivalente antigo** do `renderer.js`/`styles.css` — **só** após paridade + gate.

## Interop (montar a ilha no app legado)
`renderer.js` monta a ilha via **import dinâmico guardado** (ver `ensureChordIsland()`):
sob `electron .` (sem bundler) o `import('lit')` falha → `catch` → o legado segue intacto;
sob electron-vite (dev/build/prod) a ilha monta. Coexiste com o antigo até a paridade.

# Migração do Frontend → Lit (web components por ilhas)

> Doc de trabalho. Objetivo: quebrar `renderer.js` (~5k linhas, estado global acoplado)
> em **web components reutilizáveis** com **Lit + @lit/context**, baixando a barreira de
> contribuição **sem perder performance** nem funcionalidade. Migração **incremental por
> ilhas** (Lit e o renderer atual convivem até o fim).

Status: ☐ pendente · ◐ em andamento · ☑ concluído · ⏸ adiado

---

## 1. Contrato dos componentes (regra inegociável)

Todo componente segue as 6 qualidades. PR que não cumprir, não entra.

1. **Configurável por params** — toda entrada é `@property` reativa (ou via context).
   Nunca lê estado externo direto; recebe por prop ou serviço injetado.
2. **Idempotente** — `render()` deriva **só** de props/estado reativo; **zero efeito
   colateral em render**; efeitos vão em `updated()`/controllers. Mesmas props → mesmo DOM.
3. **Feedback padronizado (events up)** — filho emite `CustomEvent` `bubbles:true,
   composed:true` (atravessa Shadow DOM), nome `categoria:ação`, `detail` tipado.
   Filho **nunca** chama método do pai nem fala com o avô; sobe pro pai, que decide.
4. **Container entende filhos por categoria** — descobre filhos via `static category` +
   `childrenOf(cat)`; ignora nós estranhos; orquestra **props down**, ouve **events up**,
   re-emite padronizado pro próprio pai.
5. **Reuso** — lógica compartilhada em **mixins / reactive controllers / services**;
   estilo compartilhado em `css``` comum; nada duplicado.
6. **Leveza & performance** — zonas quentes (rAF: karaokê, visualizer) ficam
   **imperativas dentro de um controller**, sem re-render por frame; `content-visibility`
   + lazy onde couber; serviços singleton; Shadow DOM escopa estilo (recalc mais barato).

**Padrão de fluxo:** `props down / events up`. Estado compartilhado vive em **services**
expostos por **context**, nunca em globais soltos.

---

## 2. Arquitetura

### 2.1 Services (store) — fonte única de estado, expostos via `@lit/context`
| Service | Context | Responsabilidade | Status |
|---|---|---|---|
| `PlayerService` | `playerContext` | audio element, current, queue, play/pause/seek/next/prev, isPlaying, time | ☐ |
| `LibraryService` | `libraryContext` | lista, reload, busca/filtro, cache de paleta | ☐ |
| `PaletteService` | `paletteContext` | paleta/accent da capa atual (deriva cor) | ☐ |
| `SettingsService` | `settingsContext` | config get/set (advancedEdit, chaves, idioma, pasta) | ☐ |
| `I18nService` | `i18nContext` | `t()`, idioma, troca de idioma | ☐ |
| `DevicesService` | `devicesContext` | detecção/sync de dispositivos | ☐ |
| `ToastService` | `toastContext` | `toast(msg, tipo)` | ☐ |
| `ApiService` | (interno) | wrapper fino do `window.api` (IPC) — única ponte ao main | ☐ |

Providos uma vez no `<app-root>`. Componentes consomem via `@consume({context})`.
Regra: **componente nunca importa `window.api` direto** — só via `ApiService`.

### 2.2 Base + Mixins + Controllers (reuso transversal)
| Peça | Tipo | O que dá | Status |
|---|---|---|---|
| `SyntuneElement` | base (extends LitElement) | `emit(name, detail)`, `static category`, convenções | ☐ |
| `ContainerMixin` | mixin | `childrenOf(category)`, `onChild(name, handler)` (discovery + relay) | ☐ |
| `RafController` | reactive controller | loop rAF gerenciado (start/stop no connected/disconnected) — zonas quentes | ☐ |
| `MediaTimeController` | reactive controller | assina `timeupdate`/rAF do PlayerService; expõe `currentTime` sem re-render por frame | ☐ |
| `sharedStyles` | `css``` | tokens (cores, espaçamentos), botões, sheets/modais | ☐ |

### 2.3 Convenções
- **Arquivos:** `renderer/components/<categoria>/<nome>.js` (1 componente/arquivo).
- **Tag:** `syn-<nome>` (ex.: `syn-song-card`, `syn-chord-line`).
- **Eventos:** `syn:<categoria>:<ação>` (ex.: `syn:chord:select`), `bubbles+composed`.
- **Categorias** (p/ o container reconhecer o filho): `chord`, `lyric`, `song`, `playlist`,
  `device`, `setting`, `control`, `panel`.
- **Hot path:** nunca bindar prop a `render()` a 60fps; usar controller + escrita `style`.

### 2.4 Build & interop — **electron-vite** (decidido)
- **Ferramenta:** **`electron-vite`** (Vite p/ main+preload+renderer num só config). Deps:
  `npm i -D electron-vite vite` + `npm i lit @lit/context`.
- **Por que Vite e não esbuild puro:** precisamos de **HMR** (troca a quente, **sem
  full-reload → sem piscada e preservando estado**: áudio/karaokê/fila). esbuild sozinho
  só tem rebuild + reload total (= flicker + perde estado). Vite usa esbuild por baixo →
  velocidade do esbuild **+** HMR.
- **Não pesa no app:** bundler é **dev-only**; o bundle final = só o que se importa
  (Lit ~5 KB + nosso código), idêntico a qualquer bundler. Vite só engorda o
  `node_modules` de desenvolvimento (não empacotado).
- **Dev:** `electron-vite dev` → renderer servido pelo dev-server (HMR); o main aponta
  `loadURL(dev-server)` em dev e `loadFile(out/...)` em prod (o electron-vite já injeta
  `process.env.ELECTRON_RENDERER_URL`).
- **Prod:** `electron-vite build` → `out/{main,preload,renderer}`; o **electron-builder**
  empacota o `out/` (ajustar `build.files` e o `main` do package.json p/ apontar pro build).
- **Config mínima** (`electron.vite.config.js`): só o necessário; o "extra" do Vite é
  opcional e dev-time. Manter `main.js`/`preload.js` em CommonJS (electron-vite builda CJS).
- **Interop incremental:** o `renderer.js` atual monta cada ilha Lit no lugar do bloco
  antigo (`container.replaceChildren(document.createElement('syn-...'))`); a ilha conversa
  com o resto via os **services** (mesma instância injetada no `<app-root>`). Remove o
  código antigo da ilha **só** quando a nova passar no gate (`electron-vite dev` + `npm start`-equivalente).

---

## 2.7 Princípios de execução (anti-limbo) — leia antes de começar
Refatoração de app que funciona é onde projeto trava no meio. Regras p/ não morrer no limbo:

1. **Prova antes de generalizar** — 1 fatia vertical real (Fase 0) antes de assinar arquétipos.
   Padrão **emerge**, não se decreta.
2. **Sequencie: frontend XOR main, nunca os dois ao mesmo tempo.** Termina uma trilha (ou um
   bloco grande dela), respira, começa a outra. Migrar `main.js` e renderer juntos = troca de
   contexto constante e limbo duplo.
3. **Timebox + critério de parada** — defina janela (ex.: N semanas/M ilhas). Se não saiu,
   **reavalia** (não empurra com a barriga). Meio-migrado é o estado mais perigoso; ter um
   gatilho de "pausa e decide" evita o pântano eterno.
4. **Gate automatizado, não teatro** — a DoD só vale se for cobrada. CI roda
   `@web/test-runner` nos componentes + `node --check` + `check-i18n`. `npm start`/`electron-vite
   dev` manual é gate de comportamento, **não** o único. Sem automação, a DoD vira enfeite.
5. **Justificativa honesta** — esta refatoração se paga em **manutenção + menos bugs de estado**
   (classe que já nos mordeu) **por si só**. "Vão chegar contribuidores" é **torcida, não plano**:
   não condicione o esforço a isso. Se vierem, ótimo; se não, o código ficou melhor mesmo assim.

## 3. Estratégia por ilhas (ordem = risco crescente)

Folhas puras → containers → player → **zonas quentes por último**.

### DoD por ilha (Definition of Done — vale p/ TODAS as ilhas)
Toda ilha só é "concluída" quando cumpre, além do contrato (§1):
- [ ] **a11y** — papéis/ARIA, navegação por teclado, foco gerenciado, `prefers-reduced-motion`.
- [ ] **design tokens** — cores/espaços/raios via custom properties (nada hardcoded); o
  CSS daquele trecho do `styles.css` migra p/ o Shadow DOM + tokens compartilhados.
- [ ] **teste** — ≥1 teste do componente (props→render, eventos emitidos) com `@web/test-runner`.
- [ ] **i18n** — textos via `I18nService.t()`; paridade dos 6 dicts (`check-i18n`).
- [ ] **contrato §1** — idempotente, params, eventos padronizados, categoria.
- [ ] **sem regressão de perf** — lazy/`content-visibility` onde couber; gate `electron-vite dev` + app.
- [ ] **remove o equivalente antigo** do `renderer.js`/`styles.css` (só após o gate passar).

> As tabelas abaixo listam só os **checks ESPECÍFICOS** de cada ilha (além da DoD). Os
> específicos estão consolidados em §3.1.

### Fase 0 — Fatia vertical & padrões EMERGENTES (PRÉ-REQUISITO DE TUDO) — Status: ☑
> **Feito:** fatia vertical da **ilha de acordes** (`components/chord/syn-chord-line.js` +
> `syn-chord-mark.js`) rodando no app via electron-vite, fundindo arquétipos **A+B+C+D**
> (folha + container + conectado ao PlayerService + hot-path rAF) sob o provider **E**
> (`app-root.js`). **HMR-sem-flicker validado** no boot (áudio preservado). Padrões
> **assinados** em `components/_patterns/` (README de assinatura + 5 templates A–E).
> **Generalização confirmada (Passo 2):** `components/control/syn-switch.js` (folha de
> controle, arquétipo A) reusa base/estilos/evento padrão — ilha distinta da de acordes.
> Testes verdes: `npm run test:wc` (2 arquivos, 10 specs). Coexiste com o karaokê legado —
> remoção do antigo (paridade: weaving por linha + edição inline) = Fase E.
> **Ajuste anti-over-engineering:** o padrão **EMERGE de código real**, não é decretado de
> um spike. Não assine 5 arquétipos no papel antes de entregar 1 ilha de verdade.

**Passo 1 — 1 FATIA VERTICAL end-to-end (no app real, não no `pilot/`):** migrar **uma** ilha
completa atravessando todas as camadas — `<app-root>` provê context → componente **conectado**
→ **container** → **folha** → com store, teste, a11y e tokens, rodando no app via electron-vite.
Sugestão de fatia: **karaokê de acordes** (`syn-chord-line` + `syn-chord-mark` + um service de
tempo) — já temos o piloto provando a mecânica.

**Passo 2 — validar generalização:** repetir com **+1 a 2 ilhas de arquétipos DIFERENTES**
(ex.: uma folha de controle e um hot-path), p/ confirmar que o padrão serve a todos os casos.

**Passo 3 — SÓ ENTÃO assinar os templates** em `renderer/components/_patterns/` (A–E),
extraídos do que já funcionou. Mudar arquétipo depois = caro; por isso só assina com prova.

**Conjunto de validação (5 componentes, ilhas distintas — cobrem os arquétipos):**
| # | Componente | Ilha | Arquétipo que valida |
|---|---|---|---|
| 1 | `syn-switch` | controles | **A. Folha** (param→render puro, evento, idempotente, sem service) |
| 2 | `syn-chord-line` | karaokê | **B. Container** (entende filhos por categoria; props down / events up) |
| 3 | `syn-library` | biblioteca | **C. Conectado + aninhado** (consome service via context; filhos `syn-song-card`) |
| 4 | `syn-visualizer` | player | **D. Hot-path** (canvas/rAF via controller; sem re-render por frame) |
| 5 | `syn-settings-section` | settings | **E. Conectado + form** (lê/escreve service; feedback padrão; foco/teclado) |

**Arquétipos a assinar (1 template de referência cada):**
- **A. Folha** — só `@property` + `render` puro + `emit()`; nenhum service.
- **B. Container** — `ContainerMixin.childrenOf(categoria)`; orquestra filhos (props down),
  relê e re-emite eventos (up); não conhece o avô.
- **C. Conectado** — `@consume(context)` lê service; mapeia estado→props dos filhos; dispara
  intents (evento/chamada de service). Pode ser container (caso 3 = conectado **e** aninhado).
- **D. Hot-path** — `RafController`/`MediaTimeController`; escreve `style`/canvas direto;
  template só monta a casca.
- **E. Provider/root** — `<app-root>` provê os contexts (sai de brinde no spike do caso 3/5).

**Gate da Fase 0 (só escala depois de aprovar):**
- [ ] cada arquétipo cumpre a **DoD §3 inteira**.
- [ ] **aninhamento real provado**: provider → conectado(C) → container(B) → folha(A), com
  **context descendo** e **eventos subindo** atravessando Shadow DOM sem vazamento.
- [ ] **reuso comprovado**: A–D compartilham base/mixins/controllers (zero lógica copiada).
- [ ] **enxuto**: nada de boilerplate repetível fora de mixin/controller.
- [ ] assinatura estável (props/eventos/categorias) **documentada** → vira "como criar
  componente" no CONTRIBUTING.
- **Entregável:** `renderer/components/_patterns/` com 1 template por arquétipo (A–E) + doc de
  assinatura. Todo componente novo **copia** desses templates. Mudar arquétipo depois = caro.

### Fase A — Infra (pré-requisito) — Status: ☑ (renderer bundlado shipa; main/preload na raiz por design)
- [x] `npm i -D electron-vite vite` + `npm i lit @lit/context` (lit 3.3.3, @lit/context 1.1.6, electron-vite 5, vite 7)
- [x] `electron.vite.config.js` (main/preload/renderer) + scripts **aditivos** `dev`/`build:vite`/`preview` (start/dist intactos)
- [x] `main.js`: `loadURL(ELECTRON_RENDERER_URL)` em dev / `loadFile` em prod; `ROOT_LAYOUT` resolve preload/renderer nos 2 modos; ícone/assets via `app.getAppPath()`; `i18n.js` locales idem (seguro p/ o CLI)
- [x] **cutover de prod (renderer-only):** `dist` = `build:vite && electron-builder`; `build.files` shipa `out/renderer/**` (no lugar de `renderer/**`); `main.js` carrega `out/renderer/index.html` quando `app.isPackaged`, senão `renderer/` (dev). `lit`/`@lit/context` → devDeps (inlinados no bundle, fora do `node_modules` do app). Pack `--dir` validado (asar tem `out/renderer`, sem `renderer/` raw, sem `lit`). **main/preload seguem NÃO-bundlados na raiz por design** — evita o landmine de `worker_threads`/`sync-worker.js` dentro do asar (não testável headless). Bundlar o main também = item futuro só se necessário.
- [ ] confirmar **HMR sem flicker** (editar 1 componente, estado/áudio preservados) — visível agora que há ilha (Fase 0)
- [x] `SyntuneElement` + `ContainerMixin` + `RafController`/`MediaTimeController` + `sharedStyles`
- [x] Services + contexts (esqueleto) + `<syn-app-root>` provider (ContextProvider, sem decorators)
- [x] `ApiService` (wrap `window.api`)
- [x] **IPC type-safe:** `src/ipc/contract.js` define `IpcApi` (superfície completa de `window.api`) + payloads; **preload** implementa tipado contra `IpcApi` e **ApiService** consome, ambos com `// @ts-check`; `npm run typecheck` (tsc, no-emit) cobre o par CJS preload↔contract e roda na CI. Falta só os **handlers do main** referenciarem (depois).
- [x] ponte de interop (import dinâmico guardado: ilha monta no bundle, `electron .` cai no catch)
- [x] **gate de CI automatizado** (§2.7 #4): job `web-components` roda `typecheck` + `build:vite` + `test:wc` (Playwright); `npm test` escopado a `test/` (componentes só no `test:wc`); script `npm run gate` roda tudo local.

> **Armadilha registrada:** electron-vite + main CJS-source **não bundla `require()` relativo**
> (Vite só roda commonjs em `node_modules`). Fix: `main.build.commonjsOptions.include = [/node_modules/, /\.c?js$/]`.

### Fase B — Folhas (baixo risco, sem estado compartilhado) — Status: ☑ (9/9 componentes+teste; fiados e CONFIRMADOS no app: toast, settings, cropper, EQ, sync-badge)
| Componente | Tag | Categoria | Notas | Status |
|---|---|---|---|---|
| Toast | `syn-toast` | panel | consome ToastService (context); ícone/tipo, aria-live, auto-hide 3200+260ms | ☑ fiado+confirmado (app-root global no body; toast() encaminha) |
| Ícone | `syn-icon` | control | dados puros (ICONS); `name`/`label` (role=img) | ◐ componente+teste |
| Switch | `syn-switch` | control | param `checked`, emite `syn:control:change`; a11y role=switch | ◐ componente+teste |
| Slider | `syn-range` | control | `<input type=range>` nativo; `value/min/max/step`, emite change | ◐ componente+teste |
| Badge sync | `syn-sync-badge` | control | param `status` (synced ✓ / unsynced ○) + `label` | ◐ componente+teste+**fiado nos cards** (swap guardado: Lit no bundle, span legado sob `electron .`) |
| **Chord mark** | `syn-chord-mark` | chord | **piloto pronto** (portar do pilot) | ◐ |
| EQ panel | `syn-eq` | panel | 6 bandas (`gains`); modo `bare` (só bandas, chrome legado); **compõe 6× syn-range** | ☑ fiado+confirmado (Web Audio) |
| Cover cropper | `syn-cropper` | panel | `src`, pan/zoom (mouse+roda+**teclado**), emite `syn:cover:crop`; **compõe syn-range** | ☑ fiado+confirmado |
| Seção de settings | `syn-setting-section` | setting | accordion `open`; **compõe syn-icon** | ☑ fiado+confirmado (upgrade da sheet) |

### Fase C — Containers (entendem filhos por categoria) — Status: ☑ (containers migrados; adiados c/ rationale: virtualização da library, add-bar)
| Componente | Tag | Filhos (categoria) | Status |
|---|---|---|---|
| **Chord line** | `syn-chord-line` | `chord` (`syn-chord-mark`) | ◐ piloto |
| Song card | `syn-song-card` | song | ☑ fiado+confirmado — Lit light-DOM dirigido por VM; capa reativa (lazy, sem reload); compõe syn-icon+syn-sync-badge; intents play/menu/cover → orquestração legada. Guardado DENTRO de `buildSongCard` → herdado por lista, grupos, página de playlist e de artista |
| Library list | `syn-song-card` | song | ◐ cards = syn-song-card (confirmado); busca/agrupamento/cascata/virtualização seguem no `renderList` (renderer) |
| Playlists grid | `syn-playlist-card` | playlist | ☑ fiado — Lit light-DOM (reusa `.pl-card`); `coverHtml` props down; emite `syn:playlist:open`; card "novo" legado |
| Playlist page | `syn-song-card` (modo row) | song | ☑ faixas = `syn-song-card` c/ modo `row` (handle de drag + remover no template, emite `syn:song:remove`; reorder/drag no card); hero (cover/ações) = legado funcional |
| Artist page | `syn-song-card` | song | ☑ faixas = `syn-song-card` (agrupadas por álbum no renderer); hero/stats/bio = legado funcional |
| Devices center | `syn-device` (linha) | device | ☑ fiado+confirmado — Lit **light-DOM** (reusa CSS global + helpers por-serial); intents delegados → orquestração legada (`runScanAndSync`); capacidade/escopo+chips/progresso/sync-now. Container = `#deviceList` legado |
| Settings sheet | `syn-setting-section` | setting | ☑ via `syn-setting-section` (upgrade da sheet, Fase B) — container dedicado seria redundante |
| Add bar (YouTube) | `syn-add-bar` | control | ⏸ adiado — legado funcional; acoplado à toolbar (anim `.open`) + jobs + bindings de startup (`$('ytBtn')`…); custo > valor. Migra junto se a toolbar virar componente |

### Fase D — Player core (estado compartilhado forte) — Status: ◐ (facade + queue; mini-player em migração)
> **PlayerService = fonte única de estado (facade) ✅** — o renderer sincroniza título/artista/capa/
> isPlaying/shuffle/repeat/volume no `PlayerService` (services/player-service.js), `<audio>` real ligado;
> métodos delegam ao transporte legado (`controls.*`). Aditivo, zero regressão. O mini-player consome
> a facade reativo + rAF p/ o seek (hot-path). Now-playing migra depois.

| Componente | Tag | Notas | Status |
|---|---|---|---|
| PlayerService facade | `PlayerService` | fonte única de estado; renderer sincroniza; delega transporte | ☑ |
| Queue panel | `syn-queue-item` | item Lit light-DOM (capa/título/atual); jump/remove/reorder via intents | ☑ fiado+confirmado |
| Mini-player | `syn-mini-player` | consome PlayerService (light-DOM, host=#player); rAF no seek; controles→facade | ◐ rascunho (teste minucioso) |
| Now Playing (casca) | `syn-now-playing` | container imersivo | ☐ |

### Fase E — Zonas quentes (rAF) — POR ÚLTIMO — Status: ◐ (visualizer feito)
> Limpeza feita: removido o lixo do piloto (faixa "ilha Lit • acordes (preview)" + switch "mostrar régua")
> que ficou no `#nowPlaying` desde a Fase 0. Os componentes `syn-chord-line`/`syn-chord-mark` ficam (reusados pela karaokê).

| Componente | Tag | Cuidado | Status |
|---|---|---|---|
| Visualizer | `syn-visualizer` | canvas + Web Audio; RafController; **nunca** re-render por frame; pausa oculto | ☑ fiado+confirmado — anel circular idêntico ao legado; recebe analyser/freqData/coverEl/palette/active do renderer; light-DOM (`display:contents`, canvas `.np-viz`) |
| Karaokê (letra) | `syn-lyrics` | scroll por transform (mola), MediaTimeController | ☑ componente+teste+fiado+**gate de app OK** (usuário testou à exaustão, sem bugs); swap guardado (Lit no bundle, legado sob `electron .`/edição inline) |
| Chords overlay | `syn-chord-line` (em ctx) | barra/glow imperativos; já provado no piloto | ☑ reusado por `syn-lyrics` (1 por verso, janela `[verso.t, próximo.t]`); ganhou `.active` (gate da varredura) + `.player` (facade fora do app-root) |
| Editor inline de acorde | controller sobre `syn-chord-line` | gestos (drag/setas/criar/apagar), dirty/save | ☐ (advancedEdit segue no legado por ora) |
| Editor de letra (tap-time) | `syn-lyrics-editor` | reusa mecânica do inline | ☐ |
| Editor de detalhes (tags) | `syn-track-editor` | form + IA enrich + cropper | ☐ |

### Fase F — Limpeza — Status: ☐
- [ ] remover blocos antigos do `renderer.js` por ilha (à medida que cada uma passa o gate)
- [ ] eliminar globais mortos (current/queue/np* → migram p/ services)
- [ ] `styles.css` global → fatiado em Shadow DOM por componente + tokens compartilhados
- [ ] doc de contribuição "como criar um componente" (usa o contrato da seção 1)

---

## 3.1 Checks específicos por ilha (além da DoD §3)
| Ilha | Check específico |
|---|---|
| `syn-library` | virtualização (`@lit-labs/virtualizer`) p/ biblioteca grande; busca/agrupar como params |
| `syn-song-card` | `content-visibility:auto`; capa `loading=lazy`; teclado (Enter=tocar, menu) |
| `syn-settings` | **lazy-load** (dynamic import — só carrega ao abrir); foco-trap na sheet |
| `syn-devices` | lazy-load; estados de sync (scan/copy) com `aria-live` |
| `syn-track-editor` | lazy-load; form acessível (labels); cropper por teclado/touch |
| `syn-cropper` | gesto por teclado (setas) + touch; `aria` no recorte |
| `syn-eq` | sliders com `aria-valuenow`; `prefers-reduced-motion` |
| `syn-visualizer` | `RafController`; **pausa o rAF** quando oculto/idle; respeita reduced-motion |
| `syn-lyrics` (karaokê) | `MediaTimeController`; scroll por transform; reduced-motion (sem mola) |
| `syn-chord-line` + editor inline | a11y do **drag** (alternativa por teclado ←/→ já existe); `aria` no acorde selecionado; hint com `aria-live` |
| `syn-queue` | reorder acessível por teclado; `aria` de posição |
| `syn-add-bar` | colar URL; validação; `aria` de erro |

## 4. Regras de ouro (não violar)
- **Zonas quentes imperativas:** karaokê/visualizer escrevem `style`/canvas via controller;
  Lit só monta a casca. Reatividade por frame = engasgo.
- **Estado só em services/context** — proibido global novo solto.
- **Gate por ilha (2 camadas):** (a) **automático no CI** — `@web/test-runner` nos
  componentes + `node --check` + `check-i18n` (a DoD precisa ser *cobrada*, não confiada);
  (b) **comportamento** — `electron-vite dev`/`npm start` manual antes de remover o código
  antigo equivalente (Electron não boota headless aqui).
- **Sequenciamento:** frontend XOR main por vez; timebox com critério de parada (§2.7).
- **i18n:** todo texto via `I18nService.t()`; manter paridade dos 6 dicts (`check-i18n`).
- **Sem regressão de perf:** custom protocols, lazy cover, `content-visibility` permanecem.

## 5. Decisões
- ☑ **Build = electron-vite** (HMR sem flicker; bundler dev-only, não pesa o app). Ver §2.4.
- ☑ **IPC type-safe na 1ª leva via JSDoc + `@ts-check`** (sem TS, sem build novo). Ver Fase A.
- ☑ **TypeScript + polimorfismo/OO = 2ª grande mexida** — só DEPOIS do padrão vanilla-Lit
  assentado; com os arquivos já organizados, o port pra TS fica natural (os `@typedef`
  JSDoc convertem direto). Não embutir agora.
- [ ] Abrir mão do pitch "100% vanilla / zero-deps" do README? (Lit ~5KB) — atualizar o
  texto do README quando a 1ª ilha entrar (ex.: "vanilla + Lit ~5KB, sem framework pesado").
- [ ] Migrar tudo ou só features futuras nascem em Lit (híbrido longo) — definir no fim da Fase A.

## 5.1 Oportunidades (o que a migração destrava)
Aproveitar "já que o capô está aberto". Categorias:

**Pega-carona (vira DoD §3 — regra de PR, custo marginal):**
- a11y · design tokens · teste por componente · i18n via service · lazy-load onde pesa.

**Por-ilha (entra quando a ilha é migrada — §3.1):**
- virtualização da biblioteca · pausar rAF do visualizer oculto · lazy-load de
  editor/devices/settings · reduced-motion no karaokê.

**Ganham com o store/context (matam dores já vividas):**
- **fim da classe de bugs de estado global** (desync/stale/"erro de reprodução" vieram de
  globais soltos → fonte única resolve) · **undo/redo** nos editores (acorde/letra) ·
  **telemetria opt-in / captura de erro** (roadmap 1.5) natural na camada de service ·
  persistência de preferências de UI.

**Já na 1ª leva:**
- **IPC type-safe** (JSDoc `@ts-check`) — contrato compartilhado renderer↔main (casa com
  `MAIN-MIGRATION.md`).
- **catálogo de componentes** (1 demo isolado por componente, padrão do `pilot/`) — baixa a
  barreira de contribuição (objetivo central).

**2ª grande mexida (decisão futura, §5):**
- **TypeScript** (port dos JSDoc) + **polimorfismo/OO** ao máximo sobre o padrão já assentado ·
  CSP/segurança do renderer mais apertada.

## 6. Referências
- Piloto que valida o contrato: `pilot/chord-line/` (Vanilla × Lit; Atomico descartado por
  fricção de CDN/build).
- Filosofia equivalente no main-process: ver migração monolito→módulos já feita em `src/`.

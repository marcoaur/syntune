# ARCHITECTURE-V2 — dissolver o renderer.js em componentes autônomos

> Estado: plano vivo. Continua FRONTEND-MIGRATION.md (migração Lit + Fase F, concluídas)
> e MAIN-MIGRATION.md (Ciclo 6 do main). Meta: `renderer.js` ≈ trivial; cada subsistema
> com cérebro próprio; orquestrador mínimo.

## Princípio

Componente burro é proibido. Cada um:
- **Trata os próprios eventos** (clique/input/tecla DENTRO dele → handler dele). Nada de
  `renderer.js` ligando listener em nó de componente.
- **Só reage por acionadores** (props reativas / métodos públicos). Visibilidade é estado
  reativo dele (`.open`), não `classList` externo. Reage mesmo invisível (sempre montado).
- **Outbound = intents** (`emit('syn:cat:ação')`, bubbles+composed). **Inbound = props/métodos.**
- O que o subsistema faz sozinho fica nele; só o que cruza subsistema sobe.

## 4 arquétipos

| Arquétipo | Cara? | Acionável por | Papel |
|---|---|---|---|
| **Capacidade** (headless/dispatcher) | não (ou portal) | qualquer um | trabalho duro chamável: toast, confirm, loading, menu, palette, audio |
| **View** (smart) | sim | router/props | dona de uma tela + seu domínio |
| **Folha** (VM-driven) | sim | container | render reativo dirigido por VM + intents |
| **Orquestrador** | é o shell | — | `syn-app-root`: registry + store mínimo + bus + router |

`Capacidade ≠ render.` É escopo-de-toast sem ser a toast visual: quem precisa, pega e usa.

## Componentes-CAPACIDADE (extrair do renderer.js)

Registrados/acessíveis via `components/capabilities.js` (acessor singleton, mesmo espírito
do `toast()`). Headless renderizam portal no body (escapam stacking-context).

| Capacidade | API | Substitui | Estado |
|---|---|---|---|
| `syn-toast` | `toast(msg,type)` | — | ✓ existe |
| `syn-loading` | `loading().show(msg)/hide()` | showLoading/hideLoading/#loadingOverlay | Fase 1 |
| `syn-confirm` | `await confirm({title,message,danger})` → bool | `confirm()` plano | Fase 1 |
| `syn-menu` | `menu(anchor, items)` | openSongMenu + menus de contexto | Fase 1 |
| `syn-palette` | `await palette(url)` → {r,g,b} (cache) | getPalette/loadImage/quantização | Fase 1 |
| `syn-audio` ⚠️ | `audio.attach(el)`, `audio.eq(gains)`, `.analyser` | ensureAnalyser + grafo EQ | Fase 4 (alto risco) |
| `syn-scrobbler` | headless: assina player → scrobbla | scrobble Last.fm | Fase 3 |
| `syn-downloader` | `download.enqueue(...)`, `.jobs` reativo | pipeline Adicionar/pumpDownloads | Fase 3 |
| `syn-device-watcher` | headless: polling/eventos → `.devices` | orquestração de sync de device | Fase 3 |
| `syn-ipc` | bridge: envolve `window.api` + re-emite eventos do main no bus | 79 `window.api.*` espalhados | Fase 2 |

## Componentes-VIEW (smart, donos do domínio)

| View | Absorve do renderer | Compõe | Capacidades |
|---|---|---|---|
| `syn-library` | render/busca/agrupar/gêneros (~500) | song/artist card | palette |
| `syn-now-playing` | casca do NP (~325) | mini-player/lyrics/visualizer | audio, palette |
| `syn-playlists` + `syn-playlist-page` | CRUD/reorder/página (~361) | playlist/song card | confirm, menu |
| `syn-add` | overlay add + progresso (~208) | (jobs do downloader) | downloader |
| `syn-settings` | modal de config (~176) | setting-section | confirm |
| `syn-devices` | modal + escopo/capacidade (~329) | device | device-watcher, confirm |
| `syn-track-editor` ✓ | parar de reusar a cola; dono de save/enrich/capa (~310) | cropper/lyrics-editor | api, confirm, palette |
| `syn-artist-page` | página do artista | song card | api, palette |

Folhas existentes ganham mais autonomia (cover/paleta/estados ficam nelas).

## Orquestrador = `syn-app-root` (o mínimo)

Provê só o núcleo irredutível, monta as views UMA vez (sempre montadas; router alterna
`.active`/`.open`):
- **Registry de capacidades** (context).
- **Store mínimo reativo** (~4 campos compartilhados): `currentTrack`, `isPlaying`, `library`,
  `playlists`. Assinatura **granular** (por campo) — nada de objetão que re-renderiza tudo.
- **Event-bus**: coordenação desacoplada entre views (quem reage assina, co-localizado).

## main.js → módulos IPC (Ciclo 6, pareia por domínio)

49 handlers → `src/ipc/<domínio>.js` (registrador factory-DI): `window` · `config` · `dialogs`
· `tags` · `library` · `playlist` · `lyrics`(+chords) · `enrich`(gemini) · `lastfm` · `artist`
· `youtube` · `devices` · `i18n` · `cli` · `protocols`. Cada módulo pareia com a capacidade/view
do mesmo domínio via `syn-ipc`. main.js vira bootstrap (~250-300 ln).

## renderer.js final (~30-150 ln)

A orquestração migra pra DENTRO do `syn-app-root`. renderer.js ≈
```js
import './components/index.js';
document.body.appendChild(document.createElement('syn-app-root'));
```
O orquestrador mínimo é um COMPONENTE, não um script.

## Estado + coordenação (resolve o `export let` read-only)

- Domínio: campos de instância da view (local).
- Compartilhado mínimo: store ~4 campos, assinatura granular (signal/controller por campo).
- Cross-view: event-bus; sem coreografia no orquestrador (descentralizada pro reator).
- IPC: só no `syn-ipc` (borda); push do main → bus.
- **Hot-path** (tempo do player/karaokê/viz): NUNCA no store por frame — `RafController`
  escreve style direto (padrão D, provado).

## Ordem de execução (capacidade-first, risco crescente)

| Fase | O quê | Risco |
|---|---|---|
| 0 | infra de capacidades (`capabilities.js`) + app-root como host estável | baixo |
| 1 | capacidades: loading, confirm, menu, palette | baixo, drena geral |
| 2 | `syn-ipc` bridge + mover `window.api.*` | médio |
| 3 | engines: scrobbler, downloader, device-watcher | médio |
| 4 | `syn-audio` (grafo Web Audio + EQ) | ⚠️ alto |
| 5 | views frias→quentes: settings → add → playlists → library/artist → devices → track-editor | médio |
| 6 | `syn-now-playing` (núcleo/hot-path) | ⚠️ alto, por último |
| 7 | main Ciclo 6 (IPC modules) — paralelo | baixo-médio |
| 8 | renderer.js → entry trivial + limpar markup legado | baixo |

Cada fase: 1 commit + gate (`ELECTRON_ENABLE_LOGGING` + validação do usuário).

## Armadilhas (especialista)

- Capacidades-portal (confirm/menu/loading) no body-level (escapam stacking-context).
- `syn-audio` é a mais perigosa: grafo Web Audio compartilhado+stateful (EQ já marcado alto
  risco). Behavior-gate obrigatório; provavelmente ENVOLVE o `<audio>` real.
- Granularidade do store: assinatura por campo, senão volta o re-render global.
- Não fragmentar à toa: motor de karaokê FICA dentro de `syn-lyrics`; modal de letra
  (status+LRCLIB) UNIFICA no `syn-track-editor`.
- Épico multi-sessão, mexe em estado+hot-path (mais arriscado que a Fase F). Incremental,
  capacidade-first, gated. Nunca big-bang.
- Teto honesto: `currentTrack`/`library` são fio comum irredutível — "quase" independente,
  não total. Ganho = fio fino, explícito, único; resto roda/testa isolado.

## Contrato (DoD por componente)

- [ ] todo clique/tecla tratado DENTRO; zero listener externo no seu DOM
- [ ] todo estado externo entra por prop/método (acionador); visibilidade = estado dele
- [ ] outbound só por intent `syn:cat:ação`
- [ ] domínio local; compartilhado só via store; cross-view só via bus; IPC só via `api` injetado
- [ ] sempre montado (idle = display:none); reage invisível
- [ ] testável isolado: set props → click → assert intent

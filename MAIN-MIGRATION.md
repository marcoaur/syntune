# Migração do `main.js` → módulos de IPC (Ciclo 6 da migração monolito→módulos)

> Continuação da migração main-process já feita (`src/{config,media,services,devices}`).
> Hoje `main.js` ≈ **1349 linhas** concentrando **49 handlers IPC + 3 protocolos + pipelines**.
> Meta: `main.js` vira **só bootstrap** (janela, protocolos, ciclo de vida, auto-update,
> seed) chamando **registradores por domínio**. Sem mudança de comportamento.

Status: ☐ pendente · ◐ em andamento · ☑ concluído · ⏸ adiado

---

## 1. Padrão (factory-DI / registrador) — igual ao já usado no projeto

Cada domínio vira `src/ipc/<dominio>.js` exportando **um registrador** que recebe as
dependências por injeção (mesma filosofia de `gemini` factory e `sync-controller`):

```js
// src/ipc/<dominio>.js
module.exports = function register({ ipcMain, t, getWindow, readConfig, writeConfig, /* serviços */ }) {
  ipcMain.handle('dominio:acao', async (_e, payload) => { /* ... */ });
};
```

`main.js` no fim:
```js
require('./src/ipc/window')({ ipcMain, getWindow, nativeTheme, app });
require('./src/ipc/library')({ ipcMain, t, getLibraryDir, readId3Fast, ... });
// ... um require por domínio
```

**Regras:**
- `getWindow()` em vez de capturar `mainWindow` direto (a janela é recriada).
- Nada de lógica nova; **mover** código, não reescrever.
- Helpers compartilhados saem p/ módulos próprios (ver §3).
- Gate por ciclo: `node --check **/*.js` + `node scripts/check-i18n.js` + **`npm start` manual**.

---

## 2. Mapa handler → módulo (49 handlers + 3 protocolos)

| Módulo destino | Handlers / conteúdo | Risco | Status |
|---|---|---|---|
| `src/ipc/window.js` | `window:minimize/close`, `window:toggleFullscreen/setFullscreen`, `app:fadeoutDone`, `theme:get`, `app:getVersion` | baixo | ☐ |
| `src/ipc/config.js` | `config:get/set`, `i18n:get/setLanguage` | baixo | ☐ |
| `src/ipc/dialogs.js` | `dialog:selectMp3/selectImage/selectFolder` | baixo | ☐ |
| `src/protocols.js` | `protocol.handle` de `mp3file` / `mp3cover` / `mp3artist` + `protocolPath` | baixo | ☐ |
| `src/ipc/artist.js` | `artist:image` | baixo | ☐ |
| `src/ipc/lastfm.js` | `lastfm:authSession/scrobble/getPlaycount/getArtistInfo` | baixo | ☐ |
| `src/ipc/library.js` | `library:list/import/delete`, `image:preview` + `uniquePath` | médio | ☐ |
| `src/ipc/tags.js` | `mp3:readTags/cover/saveTags`, `chords:get/set`, `lyrics:getSyncStatus/setSyncStatus` | médio | ☐ |
| `src/ipc/lyrics.js` | `lyrics:fetchSynced/enrichFile/publish` | médio | ☐ |
| `src/ipc/cli.js` | `cli:detect/setAiEnabled`, `update:install` | médio | ☐ |
| `src/ipc/devices.js` | `devices:list/update`, `device:scan/sync/syncState/deleteTrack/enrichFromDevice`, `playlist:exportM3u/syncToDevice` | alto | ☐ |
| `src/ipc/youtube.js` | `youtube:download` (orquestração ~90 ln) | alto | ☐ |
| `src/ipc/enrich.js` | `gemini:smartMetadata/fetchMetadata` (pipeline) | alto | ☐ |

## 3. Helpers a relocar (saem do main)
| Helper | Destino | Status |
|---|---|---|
| `uniquePath` | `src/media/fs-utils.js` | ☐ |
| `factualMetadata`, `aiEnabled` + prompts do pipeline | `src/services/enrich.js` | ☐ |
| `cliCmdPaths`, `isCliInstalled`, `setUserEnvVar`, `reconcileCliKeyVar` | `src/services/cli-integration.js` | ☐ |
| `protocolPath` | `src/protocols.js` | ☐ |
| `send(channel,payload)` | injetado via deps (closure sobre getWindow) | ☐ |

## 4. O que FICA no `main.js` (bootstrap legítimo)
- `createWindow()` + ciclo de vida (`whenReady`, `activate`, `window-all-closed`, `before-quit`)
- registro dos schemes + chamada de `registerProtocols()`
- `setupAutoUpdate()`, `seedDemoLibrary()`, `initSecrets`/`i18n.init`/`loadGeminiUsage`
- a lista de `require('./src/ipc/...')({...})`
- Alvo: **~250–300 linhas** (de 1349).

---

## 5. Ordem dos ciclos (risco crescente — 1 PR por ciclo, com gate)
- **6.1** ☐ infra: criar `src/ipc/` + **`src/ipc/contract.js`** (`@typedef` JSDoc por canal:
  payload+retorno — type-safe sem TS, ver FRONTEND-MIGRATION §5/Fase A) + extrair **window +
  config + dialogs + protocols** (baixo risco, valida o padrão registrador). Handlers e
  preload referenciam o contract via JSDoc + `@ts-check`.
- **6.2** ☐ **artist + lastfm** (read-mostly).
- **6.3** ☐ **library + tags** (+ `uniquePath`→fs-utils).
- **6.4** ☐ **lyrics**.
- **6.5** ☐ **cli** (+ cli-integration helpers).
- **6.6** ☐ **devices** (8 handlers; usa sync-controller — cuidado com `connectedDevices`/estado).
- **6.7** ☐ **youtube** (download/ffmpeg/contexto).
- **6.8** ☐ **enrich/gemini** (pipeline + `enrich.js` service) — o mais pesado, por último.
- **6.9** ☐ limpeza: remover imports ociosos do main, conferir alvo de linhas, atualizar `AGENTS.md`/READMEs de módulo.

## 6. Regras de ouro
- **Mover, não reescrever** — comportamento idêntico; diff deve ser quase só recorte/colagem.
- **Mesmos nomes de canal IPC** — preload e renderer não mudam.
- **`getWindow()`** (não capturar `mainWindow`).
- Gate por ciclo: `node --check` + `check-i18n` + `npm start` (Electron não boota headless aqui).
- 1 ciclo = 1 PR pequeno e revisável (fluxo develop→stg→main).

## 7. Relação com o frontend / build
Trilhas **tecnicamente independentes** (processos diferentes): esta (`main.js`) e
`FRONTEND-MIGRATION.md` (renderer). Não conflitam em código — **MAS execute UMA DE CADA VEZ**
(frontend XOR main), não simultâneo: migrar os dois ao mesmo tempo = troca de contexto
constante e limbo duplo (ver FRONTEND-MIGRATION §2.7). Esta trilha é mais simples/mecânica
(recorte de handlers) → boa candidata a fazer **primeiro** ou em janelas curtas entre blocos
do frontend.

**electron-vite** (decidido no frontend) também builda **main + preload**: os novos
`src/ipc/*.js` entram no bundle do main automaticamente (Vite resolve os `require`/import).
Manter os módulos em **CommonJS** (como o resto de `src/`); o electron-vite empacota CJS.
Gate dos ciclos passa a ser **`electron-vite dev`** + abrir o app (em vez de `npm start` cru),
quando a Fase A do frontend estiver pronta; antes disso, `npm start` normal.

Juntas → **zero monolito**:
`renderer.js`+`styles.css`+`index.html` (frontend) e `main.js` (aqui). Sobram `sync-engine.js`
(coeso, mantém) e `src/cli/stune.js` (CLI, fatiável depois, opcional).

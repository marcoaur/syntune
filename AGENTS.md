# AGENTS.md — Syntune

> AI-first map of the codebase. Read this **before** opening files. Every class/module carries a 1-line header badge with the same taxonomy used here — read the badge, not the whole file.

---

## 1. Motivação

Syntune = **organizador + player de música offline** que:
- enriquece tags ID3 de MP3 usando **IA (Gemini)** cruzada com **fontes factuais abertas** (MusicBrainz, iTunes, LRCLIB, Genius, Last.fm);
- baixa faixas do **YouTube** (yt-dlp + ffmpeg, binários baixados sob demanda);
- toca a biblioteca com **player imersivo** (espectro Web Audio, karaokê de letra sincronizada, equalizador);
- **sincroniza** a biblioteca com **dispositivos portáteis removíveis** (pendrive / MP3 player) via worker thread.

Diferencial: pipeline de metadados **factual-first** (a IA nunca inventa sozinha — ela concilia fatos de APIs musicais) + **modo factual** que torna a IA **opcional** (o app funciona sem chave Gemini, etiquetando só com as fontes factuais) + **letra sincronizada karaokê** com editor próprio + **segredos cifrados em repouso** (AES-256-GCM + cofre do SO).

## 2. Stack

| Camada | Tecnologia |
|--------|-----------|
| Runtime | **Electron 31** (main + preload + renderer) |
| Sem bundler | renderer carregado como `<script>` clássico (`renderer/index.html` → `renderer.js`) |
| Tags MP3 | `node-id3` |
| Download | `yt-dlp-wrap` + ffmpeg (binários baixados ao 1º uso em `userData`) |
| Update | `electron-updater` (GitHub Releases, só no build NSIS) |
| Concorrência | `worker_threads` (sync-worker), `net.fetch`/`fetch` nativo |
| Áudio UI | Web Audio API (analyser, equalizador BiquadFilter) |
| i18n | módulo próprio `i18n.js` + `locales/{en,pt}.json` |
| Cripto | `crypto` (AES-256-GCM) + `safeStorage` (DPAPI/Keychain/Secret Service) |

**Regra de dependências:** projeto sem bundler. **Não** adicionar libs novas no renderer; usar APIs nativas modernas (ESM nativo, `fetch`, `URLSearchParams`, `CSS.escape`, etc.). No main process, libs Node/Electron OK se justificadas.

## 3. Taxonomia de badges (cabeçalho de cada arquivo)

Formato do cabeçalho (JSDoc):
```
/**
 * @module  <pasta>/<nome>
 * @badge   <LAYER> · <TRAITS...>
 * @role    <responsabilidade única em 1 linha>
 * @inputs  <insumos>      @outputs <saídas>
 * @deps    <dependências>
 */
```

**Layer (cor = camada arquitetural):**
| Badge | Camada | Significado |
|-------|--------|-------------|
| 🟥 CORE | Orquestração | bootstrap, janela, IPC registry, ciclo de vida |
| 🟦 SERVICE | Serviço externo | fala com API/rede de terceiros |
| 🟩 MEDIA | Mídia/arquivo | leitura/escrita de MP3, ID3, imagens |
| 🟨 DEVICE | Dispositivo | detecção/sync de hardware removível |
| 🟪 CONFIG | Config/segredos | preferências + cifragem em repouso |
| 🟧 UI | Renderer | view, player, editor, interação |
| ⬜ UTIL | Utilitário puro | helpers sem efeito colateral |

**Traits (livres, combináveis):** `NETWORK`, `FS`, `CRYPTO`, `IPC`, `RATE-LIMITED`, `STATEFUL`, `STATELESS`, `PURE`, `FACTORY-DI`, `WORKER`, `NO-NET`.

## 4. Mapa de pastas

```
main.js              🟥 CORE   bootstrap, janela, protocolos, registro de TODOS os ipcMain.handle, auto-update, orquestração do pipeline
preload.js           🟥 CORE   ponte contextBridge → window.api (única superfície renderer↔main)
i18n.js              ⬜ UTIL   t(), getLanguage(), getStrings() — i18n runtime
sync-engine.js       🟨 DEVICE lógica de varredura/cópia/diff PC↔dispositivo
sync-worker.js       🟨 DEVICE worker_threads host que roda sync-engine fora da thread principal
locales/*.json                 strings en / pt
src/
  config/
    secrets.js       🟪 CONFIG  cripto em repouso (AES-256-GCM + safeStorage); key por parâmetro     → ver src/config/README.md
    config-store.js  🟪 CONFIG  estado selado + readConfig/writeConfig/getLibraryDir/initSecrets
  media/
    id3.js           🟩 MEDIA  read/write ID3v2 rápido, lyrics, LRCLIB_SYNC tag, cover→dataURL   → ver src/media/README.md
  services/
    metadata-sources.js 🟦 SERVICE MusicBrainz + iTunes: fatos, ranking, consolidação, capa     → ver src/services/README.md
    gemini.js        🟦 SERVICE motor de rate-limit por modelo + chamada JSON estruturada (factory-DI)
    lastfm.js        🟦 SERVICE auth web-flow, scrobble, playcount, artist info (fns puras)
    youtube.js       🟦 SERVICE provisiona yt-dlp/ffmpeg sob demanda + contexto rico da página YouTube
    lyrics-lrclib.js 🟦 SERVICE LRCLIB: busca letra sincronizada (LRC) + proof-of-work p/ publicar
    artist-image.js  🟦 SERVICE Genius: foto do artista com cache em disco (mp3artist://)
  devices/
    device-detection.js 🟨 DEVICE detecção de removíveis (PowerShell/CIM, só Windows)      → ver src/devices/README.md
    sync-controller.js   🟨 DEVICE polling + estado (sync.json) + worker + scan/sync (factory-DI)
renderer/
  index.html         🟧 UI     markup + ids âncora (handlers só via addEventListener, zero inline on*); carrega renderer.js como <script type="module">
  renderer.js        🟧 UI     [MONOLITO — migração incremental p/ ESM] estado, biblioteca, player, editor de letra, EQ, devices
  modules/           ⬜ UTIL   helpers puros ESM (format/color/lrc) extraídos do monolito  → ver renderer/modules/README.md
  styles.css         🟧 UI     tema, componentes, container id-scoped
scripts/             ⬜ UTIL   build, capture, check-i18n
```

## 5. Funcionalidades → onde moram

| Funcionalidade | Arquivo(s) | Notas |
|----------------|-----------|-------|
| Bootstrap / janela / fade-close | `main.js` (`createWindow`) | 1º close = fade, 2º = fecha |
| Protocolos `mp3file://`/`mp3cover://`/`mp3artist://` | `main.js` | zero-cópia de áudio/capa, CORS p/ paleta |
| Segredos cifrados (AES-256-GCM + safeStorage) | `src/config/secrets.js` + `config-store.js` (`initSecrets`) | `secrets.enc` + `master.key`; fallback plaintext c/ aviso |
| Config (preferências) | `src/config/config-store.js` (`readConfig`/`writeConfig`/`getLibraryDir`) | separa segredos de prefs; injetado em gemini + i18n |
| Auto-update | `main.js` (`setupAutoUpdate`) | só NSIS |
| Download YouTube (yt-dlp+ffmpeg) | `src/services/youtube.js` + handler `youtube:download` em `main.js` | binários sob demanda; máx 2 jobs |
| **Pipeline inteligente de metadados** | `main.js` (`gemini:smartMetadata`) + `src/services/metadata-sources.js` + `src/services/gemini.js` | factual-first: fatos → análise IA → normalização IA |
| **Modo factual (IA opcional)** | `main.js` (`aiEnabled`, `factualMetadata`, branch em `gemini:smartMetadata`/`gemini:fetchMetadata`) | sem chave OU `useAi=false` → metadados só de MusicBrainz/iTunes + capa, pulando o Gemini. Toggle "Usar IA" em Configurações (`useAi`) |
| Fatos musicais (MusicBrainz/iTunes) | `src/services/metadata-sources.js` | throttle MB 1.1s, ranking estúdio-oficial |
| Rate-limit + chamada Gemini | `src/services/gemini.js` | fila FIFO por modelo, RPD persistido |
| ID3 read/write rápido | `src/media/id3.js` | fast path só do header ID3v2 |
| Letra sincronizada (LRCLIB) | `src/services/lyrics-lrclib.js` + handlers `lyrics:*` em `main.js` + tag em `src/media/id3.js` | publish com proof-of-work |
| Foto de artista (Genius) | `src/services/artist-image.js` + handler `artist:image` em `main.js` | cache em `userData/artists/`, servido por `mp3artist://` |
| Last.fm (auth/scrobble/playcount/artist) | `src/services/lastfm.js` | fns puras; main injeta chaves |
| Biblioteca (listar/importar/excluir) | `main.js` (`library:*`) + render em `renderer.js` | varre pasta configurada |
| Player / espectro / EQ / karaokê | `renderer/renderer.js` | Web Audio; **a modularizar** |
| Editor imersivo de letra | `renderer/renderer.js` (`openLyricsEditor`...) | undo/redo, offsets, validação de ordem |
| Detecção de dispositivos removíveis | `src/devices/device-detection.js` | polling via PowerShell/CIM (só Windows) |
| Sincronização PC↔dispositivo | `src/devices/sync-controller.js` + `sync-engine.js` + `sync-worker.js` + handlers em `main.js` | serializada por dispositivo |

## 6. Regras importantes / o que NÃO pode falhar

1. **Segredos nunca em plaintext** quando o cofre do SO existe. `SECRET_FIELDS` saem do `config.json` → `secrets.enc`. Migração de instalações antigas é obrigatória (`initSecrets`).
2. **`window.api` é a única ponte** renderer↔main (`preload.js`). Renderer não acessa Node direto. Toda nova IPC: registrar handler em `main.js` **e** expor em `preload.js`.
3. **Renderer sem handlers inline** — só `addEventListener`. Manter ids do `index.html` estáveis (são âncoras de wiring e de CSS id-scoped).
4. **Pipeline factual-first**: a IA concilia fatos, não inventa. Não remover a etapa de `gatherFacts`/`consolidateFacts` antes do Gemini. A IA é **opcional** (`aiEnabled(cfg) = cfg.useAi !== false && !!cfg.apiKey`): sem chave ou com `useAi=false`, o app cai no **modo factual** (`factualMetadata`) — o app NÃO pode exigir chave para funcionar.
5. **Rate-limit Gemini**: toda chamada passa por `acquireGeminiSlot`. RPD persiste entre reinícios — não burlar.
6. **Throttle MusicBrainz ≥1.1s** (User-Agent obrigatório) — sob risco de ban.
7. **Exclusão de biblioteca** só dentro da pasta configurada (guard em `library:delete`).
8. **Sync serializada por dispositivo** — não paralelizar cópia no mesmo serial.
9. **i18n**: toda string de UI via `t(...)`; rodar `scripts/check-i18n.js`.

## 7. Gate de qualidade

- Sintaxe main: `node --check main.js` + `node --check` em cada `src/**/*.js`.
- i18n: `node scripts/check-i18n.js`.
- Comportamento: rodar `npm start` (Electron) e exercitar o fluxo afetado — `node --check` **não** pega wiring de IPC/CSS.

---
_Migração monolito→módulos em andamento. `modulos_concluidos` e pendências no rodapé de cada ciclo (#LOOP_STATUS) da conversa de orquestração._

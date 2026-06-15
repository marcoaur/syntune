# src/services — 🟦 Serviços externos

Módulos que falam com APIs/rede de terceiros. Sem estado de UI, sem `ipcMain`. `main.js` registra os handlers e chama estas funções.

## Mapa de arquivos

| Arquivo | Badge | Responsabilidade única |
|---------|-------|------------------------|
| `metadata-sources.js` | 🟦 SERVICE · NETWORK · RATE-LIMITED(MB 1.1s) | Fatos musicais de **MusicBrainz + iTunes**: busca, ranking (estúdio-oficial), consolidação, capa em alta, parse "Artista - Título", bloco de fatos p/ prompt |
| `gemini.js` | 🟦 SERVICE · RATE-LIMITED · STATEFUL · FACTORY-DI | Motor de **rate-limit por modelo** (fila FIFO RPM/TPM/RPD, RPD persistido) + `callGemini` (JSON estruturado) |
| `lastfm.js` | 🟦 SERVICE · CRYPTO(md5) | **Last.fm**: auth web-flow, scrobble, playcount, artist info (fns puras; chaves injetadas pelo caller) |
| `youtube.js` | 🟦 SERVICE · BINARY-DOWNLOAD · FS | Provisiona **yt-dlp/ffmpeg** sob demanda (dedupe por promise) + coleta contexto rico da página YouTube; `sanitizeName`/`isYouTubeUrl` |
| `lyrics-lrclib.js` | 🟦 SERVICE · CRYPTO(sha256-PoW) | **LRCLIB**: busca letra sincronizada (get+search), detecção LRC, proof-of-work p/ publicar |
| `artist-image.js` | 🟦 SERVICE · FS-CACHE · RATE-LIMITED(~400ms) | **Genius**: foto do artista com cache em disco + migração legado; devolve URL `mp3artist://` |

## Fluxo de dados

```
                 seedArtist/seedTitle
                        │
   metadata-sources.gatherFacts ──► {musicbrainz, itunes}
                        │ consolidateFacts
                        ▼
                facts (factual-first)         cfg(apiKey,model)
                        │ factsBlock                 │
                        ▼                            ▼
   main.js (gemini:smartMetadata) ──prompt──► gemini.callGemini ──► ID3 JSON
                        │                                              │
            fetchFactualCover(facts) ──► coverDataUrl                 ▼
                                                              formulário/editor (renderer)
```

**Insumos:** sementes artista/título, `cfg` (apiKey/model/chaves), parâmetros de track.
**Saídas:** objeto de fatos consolidado, JSON ID3 validado por schema, data URLs de capa, dados Last.fm (playcount/bio/tags).

## Contratos

- `metadata-sources`: exporta `mbSearchRecordings, mbToMatches, itunesLookup, gatherFacts, consolidateFacts, fetchFactualCover, parseArtistTitle, factsBlock, fuzzyMatch, normName`. Deps: `fetch` global, `../../i18n`. Throttle MB privado (≥1.1s).
- `gemini`: **factory** `createGeminiService({ readConfig, writeConfig })` → `{ callGemini, loadGeminiUsage, estimateTokens, acquireGeminiSlot, ID3_SCHEMA }`. Estado em memória por instância (1 por app).
- `lastfm`: exporta `sign, authSession, scrobble, getPlaycount, getArtistInfo`. Fns puras — o `main.js` lê `cfg` e injeta as chaves; o gate de `lastfmScrobbleEnabled` fica no handler.

## Invariantes

1. Throttle MusicBrainz ≥1.1s + User-Agent — não burlar (risco de ban).
2. Toda chamada Gemini passa por `acquireGeminiSlot`; RPD persiste entre reinícios.
3. `lastfm.sign` usa MD5 por **imposição** do protocolo Last.fm — não trocar o algoritmo.

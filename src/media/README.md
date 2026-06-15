# src/media — 🟩 Mídia / arquivos

Leitura e escrita de arquivos de mídia (MP3/ID3, imagens). Sem rede, sem estado, sem `ipcMain`.

## Mapa de arquivos

| Arquivo | Badge | Responsabilidade única |
|---------|-------|------------------------|
| `id3.js` | 🟩 MEDIA · FS · STATELESS · NO-NET | Tags ID3v2 (fast path só do header), letra, tag `LRCLIB_SYNC`, capa/imagem → data URL |

## Fluxo de dados

```
filePath ──► readId3Fast ──► tags{title,artist,album,image,userDefinedText,...}
                 │                       │
                 ├─ lyricsText(tags) ──► texto da letra
                 ├─ readLrclibSync ────► 'synced'|'local'|'not_found'|null
                 └─ writeLrclibSync ───► grava TXXX:LRCLIB_SYNC (preserva outros TXXX)

filePath ──► coverDataUrl ─────► "data:image/...;base64,..." | null
imagePath ─► imagePreviewDataUrl► "data:image/...;base64,..." | null
```

**Insumos:** caminho de arquivo MP3 / imagem, objetos de tags.
**Saídas:** objetos de tags, strings (letra, status, data URLs), booleans.

## Contrato

Exporta `readId3Fast, lyricsText, readLrclibSync, writeLrclibSync, coverDataUrl, imagePreviewDataUrl, LRCLIB_SYNC_DESC`. Deps: `fs`, `path`, `node-id3`.

## Invariantes

1. `readId3Fast` lê só a região do cabeçalho ID3v2 (synchsafe) — não carregar o arquivo inteiro (trava em MP3 grande/com capa). Fallback p/ leitura completa só sem ID3v2 no início.
2. `writeLrclibSync` preserva os demais frames `TXXX` ao gravar `LRCLIB_SYNC`.
3. Sem efeito de rede; seguro p/ chamar em varredura de biblioteca inteira.

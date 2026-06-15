# renderer/modules — ⬜ Utilitários puros do renderer (ESM)

Funções **puras** extraídas do monolito `renderer/renderer.js`. Sem estado, sem efeito colateral (DOM/window só em call-time). Carregadas como ES modules (`index.html` → `<script type="module">`).

## Mapa de arquivos

| Arquivo | Badge | Responsabilidade única |
|---------|-------|------------------------|
| `format.js` | ⬜ UTIL · PURE | `normPart, keyOf, normalizeText, artistInitials, escapeHtmlText, cssEsc, fmtBytes, fmtDb` |
| `color.js` | ⬜ UTIL · PURE | `rgbToHsl, hslToRgb, deriveBarColors, lerpPal` (paleta dinâmica das barras do visualizador) |
| `lrc.js` | ⬜ UTIL · PURE | `isSyncedLyrics, parseLrc, lrcToPlain, parseLrcTime, fmtTimestamp, parseLrcSeconds, parseLyricsToLines, serializeLines` |
| `constants.js` | ⬜ UTIL · DATA | `LYRICS_STATUS` (5 estados de letra), `EQ_BANDS`, `EQ_BUILTINS` (presets do EQ) |
| `icons.js` | ⬜ UTIL · DATA(SVG) | `ICONS` — 21 ícones SVG inline (currentColor) |

## Fluxo de dados

```
renderer.js  ──import──►  format/color/lrc  (funções puras: entrada → saída, sem estado)
```

**Insumos:** strings/números/objetos de faixa, texto LRC.
**Saídas:** strings/arrays/valores formatados ou parseados.

## Regras

1. Só entra aqui o que é **puro** — não usa `t()` (i18n), estado do renderer, nem variáveis de módulo. (Ex.: `formatPlaycount` usa `t()` → ficou no renderer.)
2. `escapeHtmlText`/`cssEsc` tocam `document`/`window`, mas só quando chamados — seguros p/ importar em qualquer ordem.
3. Migração do renderer é incremental: este é o 1º lote (utilitários). Clusters com estado (player, biblioteca, editor) virão em sub-lotes, cada um com gate de comportamento (`npm start`).

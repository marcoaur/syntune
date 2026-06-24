# Piloto — Linha de acorde (Vanilla × Atomico × Lit)

Mesma feature, mesmo **contrato**, 3 implementações, para comparar verbosidade/ergonomia.
A "linha de acorde" = container que posiciona acordes pelo tempo, com barra de varredura
+ ponto-cabeça, e cada acorde pulsa ao ser alcançado (igual ao karaokê real).

## Contrato compartilhado (vale p/ a refatoração inteira)

Princípio: **props descem, eventos sobem**. Filhos burros/idempotentes; container orquestra.

### `<chord-line>` — CONTAINER
- **Entende os filhos pela CATEGORIA** (`querySelectorAll('chord-mark')`); ignora nós estranhos.
- **Params (entrada):** `start` (s), `end` (s), `current` (s, tempo de reprodução), `accent` ("r,g,b").
- **Orquestra:** calcula `pos` (0..1) e `glow` (0..1) de cada filho a partir do `time` dele +
  do intervalo da linha + `current`; injeta `accent`; move a barra/cabeça.
- **Feedback ao SEU pai (padronizado):** re-emite `chordline-select` / `chordline-edit`
  (`bubbles+composed`) ao receber os eventos dos filhos.

### `<chord-mark>` — FILHO
- **Configurável por params:** `label`, `time`, `pos`, `glow`, `accent`. Nada de estado oculto.
- **Idempotente:** renderiza só a partir das props → mesma entrada, mesma saída; setar de novo
  não acumula efeito.
- **Feedback padronizado (sobe):** `chordmark-select` / `chordmark-edit` (`bubbles+composed`),
  `detail: { time, label }`.

### Regras transversais (reuso)
- Eventos **kebab-case** + `bubbles:true, composed:true` (atravessam Shadow DOM).
- O pai NUNCA lê o estado interno do filho; só seta props e ouve eventos.
- O filho NUNCA fala com o avô direto; sobe pro pai, que decide re-emitir.
- Posições/cores via `style`/CSS var (não re-template) → seguro a 60fps.

## Como rodar
⚠️ **NÃO abra o `index.html` por `file://`** — o Chrome bloqueia `import` de módulo ESM em
`file://` (CORS) e nada carrega. Sirva por **http**:

```
node pilot/serve.js
```
Depois abra:
- **http://localhost:8080/chord-line/compare/  ← Vanilla × Lit lado a lado (controle único sincroniza)**
- http://localhost:8080/chord-line/vanilla/  (0 dependência, roda offline)
- http://localhost:8080/chord-line/lit/      (puxa Lit de esm.sh — precisa de internet)

A página `compare/` usa iframes (registries isolados — necessário porque ambos registram o
mesmo nome `chord-line`) e dirige os dois via `postMessage`.

> **Atomico ficou fora da comparação ao vivo.** Não carrega de forma confiável por CDN
> (`atomico@3` nem existe; a entrada do `@2.1.0` no esm.sh não expõe `c`/`html` direto) —
> exige `npm i atomico` + bundle. Os arquivos em `atomico/` ficam como referência, mas
> precisam de build. Essa fricção de setup já pesa contra ele para contribuição. **Lit**
> (mesma faixa de peso, ~5 KB) carrega liso por CDN — vantagem prática real.

Em produção seria `npm i lit`/`atomico` + bundle (esbuild/vite); o `esm.sh` é só p/ o piloto.

Cada demo tem: a linha com 4 acordes, um slider de `current`, play automático e um log dos
eventos que sobem — pra você ver o feedback padronizado chegando no container.

## O que comparar
- **Linhas de código** de cada par (child+container).
- **Boilerplate** (reflect de atributos, lifecycle, binding de evento).
- **Clareza** do "props down / events up".
- Peso da dependência: Vanilla 0 KB · Atomico ~3–4 KB · Lit ~5–6 KB (min+gz).

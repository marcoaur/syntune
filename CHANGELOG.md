# Changelog

Todas as mudanças relevantes deste projeto são documentadas aqui.

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/);
o projeto adere ao [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Não lançado]

## [2.1.1] — 2026-06-15

### Alterado
- **CI:** actions `actions/checkout` e `actions/setup-node` atualizadas para o runtime Node 24 (`@v4` → `@v6`), resolvendo a deprecação do Node 20.

### Limpeza
- Remoção de código não utilizado e de comentários-ponteiro deixados pela migração modular (`allEqPresets`, breadcrumbs `// X → src/…` em `main.js`).
- Adicionado `CHANGELOG.md`.

## [2.1.0] — 2026-06-15

### Adicionado
- **Modo factual (IA opcional):** o app passa a funcionar **sem chave do Gemini**. Sem chave — ou com a IA desligada — os metadados vêm direto das fontes factuais (MusicBrainz + iTunes), com capa em alta (Cover Art Archive/iTunes) e letra sincronizada (LRCLIB). A IA passa a ser um reforço, não um requisito.
- **Toggle "Usar IA (Gemini)"** em Configurações, persistido (`useAi`). Desligado força o modo factual mesmo com chave configurada.
- **Suíte de testes** (`node:test`, sem dependências externas): 29 testes cobrindo cripto de segredos (AES-256-GCM), fontes de metadados, parsing de letra (LRC), formatação e chave de sincronização. `npm test`.
- **AGENTS.md** + READMEs por módulo (mapa de arquivos + fluxo de dados) e cabeçalhos-badge classificatórios em cada arquivo.

### Alterado
- **Refatoração de arquitetura:** monolito dividido em 16 módulos especialistas — `src/{config,media,services,devices}` (processo principal) e `renderer/modules/{format,color,lrc,constants,icons}` (renderer em ES modules). `main.js` reduzido de 2493 → ~1150 linhas. Sem mudança de comportamento.
- **CI:** verificação de sintaxe passa a cobrir todo o JS do projeto (`**/*.js`, incluindo `src/**` e `renderer/modules/**`) e roda os testes unitários.

### Corrigido
- **Áudio mudo no Electron 41:** o Chromium novo impõe estritamente CORS na Web Audio API; `createMediaElementSource` sobre o protocolo `mp3file://` (cross-origin) silenciava a saída. Corrigido com `audio.crossOrigin = 'anonymous'` (o handler já envia `Access-Control-Allow-Origin: *`).

### Segurança
- **Dependências atualizadas** (resolve os apontamentos do Dependabot — 0 vulnerabilidades):
  - `electron` 31 → 41 (17 CVEs: ASAR integrity bypass, use-after-free, header injection, etc.).
  - `electron-builder` 24 → 26 (corrige `node-tar` — path traversal / symlink poisoning, transitivo).

## [2.0.8] — 2026-06-12

### Corrigido
- Seek do áudio e cliques nos números de linha do editor de letras.

## [2.0.7] — 2026-06-12

- Release de manutenção.

---

Versões anteriores (≤ 2.0.6): ver as [Releases no GitHub](https://github.com/marcoaur/syntune/releases).

[Não lançado]: https://github.com/marcoaur/syntune/compare/v2.1.1...HEAD
[2.1.1]: https://github.com/marcoaur/syntune/releases/tag/v2.1.1
[2.1.0]: https://github.com/marcoaur/syntune/releases/tag/v2.1.0
[2.0.8]: https://github.com/marcoaur/syntune/releases/tag/v2.0.8
[2.0.7]: https://github.com/marcoaur/syntune/releases/tag/v2.0.7

# Changelog

Todas as mudanças relevantes deste projeto são documentadas aqui.

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/);
o projeto adere ao [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Não lançado]

## [2.3.0] — 2026-06-15

### Corrigido
- **Modal de Configurações cortado:** o conteúdo extrapolava a janela. Agora as configurações são **seções colapsíveis (accordion)** — só 1 aberta por vez (Idioma, IA, Genius, Last.fm, Biblioteca) — e a sheet tem altura máxima com rolagem de segurança.
- **i18n da feature de letra:** badges de sincronização, card de status, modal de opções (textos contextuais), o editor (menu/hints/cabeçalhos/botões), **e os toasts/confirmações + erros de publicação (renderer e main)** estavam hardcoded em PT — agora tudo passa pelo i18n. Varredura confirma 0 strings de UI hardcoded restantes (67 chaves novas, en/pt).

### Adicionado
- **4 novos idiomas de interface — Espanhol, Francês, Alemão e Russo** (de 2 para 6 idiomas). Alcance: Espanha + América Latina; França/Canadá/África; mercados FOSS/privacidade de língua alemã; e Rússia (onde o modo factual brilha, pois o Gemini é geo-restrito). Aparecem automaticamente no seletor. Tradução completa dos 408 textos cada (revisão por nativo recomendada antes de campanhas nesses mercados).
- **Seletor de idioma nas Configurações** — escolha manual entre os idiomas disponíveis em `locales/`, ignorando o locale do sistema; opção "Automático" volta a detectar pelo SO. Aplica reiniciando o app.

### Documentação
- **READMEs localizados** — `README.es.md`, `README.fr.md`, `README.de.md`, `README.ru.md` (tradução completa) + seletor de idiomas atualizado em todos os READMEs (6 idiomas).
- README (en/pt) reposicionado: herói "organize, enriqueça e possua sua biblioteca"; IA opcional; download de link como feature secundária (não a manchete). Seção de download inclui macOS/Linux.

### Testes
- Smoke E2E (Playwright/Electron): lança o app e falha se ele não abrir / houver erro de JS no boot. Novo job `e2e` no CI (ubuntu + xvfb).

## [2.2.0] — 2026-06-15

### Adicionado
- **Suporte a macOS e Linux** — o app agora roda além do Windows. Instaladores `dmg`/`zip` (macOS) e `AppImage`/`deb` (Linux) gerados a cada release. A detecção/sync de dispositivos removíveis (CIM/PowerShell) vira no-op fora do Windows; o restante funciona em todas as plataformas. *(macOS/Linux ainda não assinados — notarização adiada.)*

### Alterado
- **Release multiplataforma:** o workflow de build/release passa a rodar em matrix (Windows + macOS + Linux), publicando os assets das três plataformas numa única release.

## [2.1.2] — 2026-06-15

### Documentação
- README (en/pt) e AGENTS.md documentam o **modo factual** (IA opcional): o app funciona sem chave do Gemini, etiquetando com MusicBrainz / iTunes / LRCLIB.

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

[Não lançado]: https://github.com/marcoaur/syntune/compare/v2.3.0...HEAD
[2.3.0]: https://github.com/marcoaur/syntune/releases/tag/v2.3.0
[2.2.0]: https://github.com/marcoaur/syntune/releases/tag/v2.2.0
[2.1.2]: https://github.com/marcoaur/syntune/releases/tag/v2.1.2
[2.1.1]: https://github.com/marcoaur/syntune/releases/tag/v2.1.1
[2.1.0]: https://github.com/marcoaur/syntune/releases/tag/v2.1.0
[2.0.8]: https://github.com/marcoaur/syntune/releases/tag/v2.0.8
[2.0.7]: https://github.com/marcoaur/syntune/releases/tag/v2.0.7

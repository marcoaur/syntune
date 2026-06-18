---
name: Syntune CLI Orchestrator
description: Baixa, enriquece e organiza músicas do YouTube via o comando `stune`. Use quando o usuário quiser baixar música(s) do YouTube, criar/preencher playlists do Syntune, ou listar playlists existentes — tudo pelo terminal, sem abrir o app.
---

# Syntune CLI Orchestrator

Agente autônomo que opera o **Syntune CLI** (comando `stune`) para baixar músicas do YouTube, enriquecê-las com metadados de alta qualidade (idêntico ao app desktop) e organizá-las em playlists. O CLI compartilha os dados com o app Syntune instalado — playlists criadas pelo CLI aparecem no app e vice-versa.

## O que o CLI faz por baixo (não precisa orquestrar isto — é automático)
Para cada URL, em paralelo: baixa o áudio (yt-dlp+ffmpeg → mp3) → deriva artista/título reais (não o nome do vídeo) via metadados de música do YouTube + MusicBrainz/iTunes → busca capa em alta (CoverArtArchive/iTunes, fallback thumbnail) → busca letra sincronizada (LRCLIB) → detecta idioma da letra → grava tags ID3 completas (título, artista, álbum, albumArtist, ano, gênero, faixa, capa, letra) → salva como `Artista - Título.mp3` na pasta de download → adiciona à playlist (se pedido).

**Dois modos de qualidade (automático):**
- **Factual** (padrão, sem chave): MusicBrainz + iTunes + LRCLIB. Já é alta qualidade.
- **IA** (quando `STUNE_API_KEY` existe): pipeline Gemini de 2 chamadas (análise+lacunas → consistência+normalização ID3) ancorado nos fatos. Limpa "(Official Video)", infere feat./compositor/gênero, comentário. Cai em factual se a IA falhar.

## Os 3 modos do comando (decida qual usar)

| Intenção | Comando | Efeito |
|---|---|---|
| Só baixar+enriquecer (sem playlist) | `stune -y URL1,URL2` | Salva os mp3 na pasta de download. **Não** toca em playlist. |
| Baixar+enriquecer+adicionar à playlist | `stune -y URL1,URL2 -pl "Nome"` | Faz o download e adiciona à playlist. **Cria a playlist se não existir, sem perguntar.** |
| Listar faixas de uma playlist | `stune -pl "Nome"` | Imprime as faixas. **Se a playlist NÃO existe, pergunta `(s/N)` no stdin** (ver armadilha abaixo). |
| Ajuda | `stune` | Mostra uso dos 3 modos. |

### Sintaxe — regras rígidas
- **URLs**: uma string única **separada por vírgula, sem espaços**. Use **URLs de vídeo individuais** (o CLI usa `--no-playlist`; URL de playlist do YouTube vira só 1 vídeo).
- **Sempre cite** as URLs e o nome da playlist (espaços, `&`, `?` quebram o shell): `stune -y "https://youtu.be/abc","https://youtu.be/def" -pl "Treino 2026"`.
- Flags podem vir em qualquer ordem. Sem `-y` e sem `-pl` → imprime ajuda.

## ⚠️ Armadilhas que travam/derrubam agentes (leia antes de executar)

1. **Prompt interativo trava o agente.** `stune -pl "X"` quando `X` **não existe** bloqueia esperando `s/N` no stdin. Um agente sem stdin **trava**. Regras:
   - Para **criar+popular** uma playlist: use `stune -y URLs -pl "Nome"` — **auto-cria, nunca pergunta**. Prefira sempre esta forma.
   - Para só **criar vazia** ou **listar** uma playlist que pode não existir: forneça a resposta no stdin. PowerShell: `"s" | stune -pl "Nova"` (cria) ou `"n" | stune -pl "X"` (não cria). Bash/Git-Bash: `printf 's\n' | stune -pl "Nova"`.
   - Para **listar com segurança** sem risco de prompt: cheque antes se a playlist existe no `config.json` (ver Verificação) e só então rode `stune -pl`.

2. **PATH só vale em shell novo.** Após instalar o CLI (via instalador do app), `stune` só resolve num terminal **aberto depois** da instalação. Se "comando não encontrado", abra novo shell ou chame direto: `node "<repo>/src/cli/stune.js" ...` (dev) ou o `cli/stune.cmd` instalado.

3. **Modo IA é silencioso se faltar chave.** Sem `STUNE_API_KEY`, o CLI **não avisa** — só roda em factual. Se o usuário quer IA, garanta a env var (ver abaixo) **antes** de rodar.

4. **1 URL ruim não derruba o lote.** Downloads rodam em paralelo com `Promise.allSettled`; URLs que falham viram status vermelho e o resto continua. Sempre confira o resumo final.

## Habilitar o modo IA (Gemini)
A chave do app fica **cifrada** (`secrets.enc`) e **não** é legível pelo CLI. O CLI lê a chave nesta ordem: `STUNE_API_KEY` (env) → `GEMINI_API_KEY` (env) → `apiKey` plaintext do `config.json`. Opções para o usuário:
- **Pelo app (recomendado)**: Configurações → IA → ligar **"Usar IA no Syntune CLI?"**. O app grava `STUNE_API_KEY` como variável de ambiente do usuário.
- **Manual (Windows)**: `setx STUNE_API_KEY "<chave>"` (vale em shell novo). Sessão atual (PowerShell): `$env:STUNE_API_KEY="<chave>"`.
- **Manual (bash)**: `export STUNE_API_KEY="<chave>"`.

## Variáveis de ambiente (overrides)
| Var | Efeito |
|---|---|
| `STUNE_API_KEY` / `GEMINI_API_KEY` | Chave Gemini para o modo IA. |
| `STUNE_USER_DATA` | Caminho direto da pasta de dados (sobrepõe a detecção). |
| `STUNE_DEV=1` | Usa a pasta de dados de **dev** (`syntune-dev`) em vez da instalada (`Syntune`). |

## Onde ficam os dados
Pasta `userData` (compartilhada com o app):
- Windows: `%APPDATA%\Syntune`
- macOS: `~/Library/Application Support/Syntune`
- Linux: `~/.config/Syntune`

Contém: `config.json` (playlists, downloadFolder, model, useCliAi), `yt-dlp.exe`, `ffmpeg.exe`, `secrets.enc`. Os mp3 vão para `config.json → downloadFolder` (fallback: tmp).

## Fluxo do agente
1. **Coletar URLs**: do usuário, ou via web search filtrando **apenas links do YouTube** (`youtube.com`/`youtu.be`/`music.youtube.com`), URLs de vídeo individuais.
2. **Definir playlist** (se aplicável): nome do usuário, ou inferir do contexto (ex.: "Lo-fi Estudo", "Hits 2026").
3. **Garantir IA se desejada**: checar/definir `STUNE_API_KEY`.
4. **Executar** o modo correto da tabela. Para criar+popular, sempre `stune -y URLs -pl "Nome"`.
5. **Verificar** (abaixo).

## Verificação (sem travar)
- **Stdout**: o CLI termina com `N concluída(s)[, M com erro].` e, no modo playlist, `K faixa(s) ... "Nome".`. Parse isso.
- **config.json**: confirme as faixas na playlist sem invocar o prompt interativo. PowerShell:
  ```powershell
  $c = Get-Content "$env:APPDATA\Syntune\config.json" -Raw | ConvertFrom-Json
  ($c.playlists | Where-Object { $_.name -eq "Nome" }).tracks
  ```
- Mp3 gerados ficam em `$c.downloadFolder`, nomeados `Artista - Título.mp3` (colisão → `(1)`, `(2)`...).

## Troubleshooting
| Sintoma | Causa | Ação |
|---|---|---|
| `stune` não encontrado | PATH não recarregado | Abra shell novo, ou chame o `.cmd`/`node ...stune.js` direto. |
| `HTTP Error 403` / extração falha | yt-dlp desatualizado | `"%APPDATA%\Syntune\yt-dlp.exe" -U` |
| Status vermelho numa faixa | URL inválida/privada/região | Confira a URL; as outras seguem. |
| Agente travou sem output | Prompt `s/N` da listagem de playlist inexistente | Use `-y ... -pl` (auto-cria) ou pipe `"s"`/`"n"` no stdin. |
| IA não rodou (saiu factual) | Sem `STUNE_API_KEY` | Defina a env var e rode em shell novo. |
| `Node 18+ necessário` | Runtime antigo | Use o `Syntune.exe` (RUN_AS_NODE) ou Node ≥18. |

## Exemplos de prompt para agentes
- "Pesquise 'Lo-fi Hip Hop 2026' no YouTube, pegue os 5 melhores vídeos e crie a playlist 'Lo-fi Estudo' no Syntune."
  → `stune -y "url1","url2","url3","url4","url5" -pl "Lo-fi Estudo"`
- "Baixe e enriqueça estas 2 músicas, sem playlist: <url1> <url2>."
  → `stune -y "url1","url2"`
- "Quantas faixas tem a playlist 'Treino'?" → cheque o `config.json` (acima) e/ou `stune -pl "Treino"` (só se você sabe que existe).

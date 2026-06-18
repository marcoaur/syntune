#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const readline = require('readline');

// ── Config ── (resolve userData IGUAL ao app Electron, p/ compartilhar config/playlists/binários)
// Nome do app: prod usa productName "Syntune"; dev (npm start) usa "syntune-dev" (main.js:33).
// O CLI é lançado pelo Syntune.exe instalado (STUNE_APP_DIR setado pelo installer) → prod.
// Overrides: STUNE_USER_DATA (caminho direto) > STUNE_DEV=1 (força pasta dev).
function resolveUserData() {
    if (process.env.STUNE_USER_DATA) return process.env.STUNE_USER_DATA;
    // dev quando rodado fora do app instalado (sem STUNE_APP_DIR) E pedido explícito
    const appName = process.env.STUNE_DEV === '1' ? 'syntune-dev' : 'Syntune';
    if (process.platform === 'win32') {
        return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', appName);
    }
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appName);
}
const USER_DATA = resolveUserData();
const CONFIG_PATH = path.join(USER_DATA, 'config.json');

function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8').replace(/^﻿/, '')); } catch { return { playlists: [] }; } }
function writeConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8'); }

// API key: secrets.enc do app é cifrado (OSCrypt v10 + DPAPI) e NÃO é decifrável fora do
// Electron (RUN_AS_NODE não expõe safeStorage; exe empacotado ignora script-arg). Por isso o
// CLI obtém a chave de: env STUNE_API_KEY/GEMINI_API_KEY > apiKey plaintext do config.json.
function resolveApiKey(cfg) {
    return process.env.STUNE_API_KEY || process.env.GEMINI_API_KEY || (cfg && cfg.apiKey) || '';
}

// ── Modulos do App ──
const projectRoot = path.join(__dirname, '..', '..');
const { gatherFacts, consolidateFacts, fetchFactualCover, parseArtistTitle, factsBlock } = require(path.join(projectRoot, 'src', 'services', 'metadata-sources'));
const { fetchLrclib } = require(path.join(projectRoot, 'src', 'services', 'lyrics-lrclib'));
const NodeID3 = require('node-id3');

// i18n (mesmo singleton que o gemini.js usa internamente p/ os prompts)
const i18n = require(path.join(projectRoot, 'i18n'));
i18n.init({ locale: Intl.DateTimeFormat().resolvedOptions().locale || 'en', readConfig, writeConfig });
const t = i18n.t;

// serviço Gemini (mesmo motor de rate-limit e callGemini do app)
const createGeminiService = require(path.join(projectRoot, 'src', 'services', 'gemini'));
const gemini = createGeminiService({ readConfig, writeConfig });
gemini.loadGeminiUsage();

// IA ligada? precisa de chave E não ter sido desativada (useAi=false) — igual main.js:572
function aiEnabled(cfg) { return cfg.useAi !== false && !!cfg.apiKey; }

// node 18+ exige fetch global
if (typeof fetch !== 'function') {
    console.error('Erro: Node 18+ necessário (fetch global indisponível).');
    process.exit(1);
}

const YTDLP = path.join(USER_DATA, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

// detecção de idioma da letra → ISO 639-2 (3 letras) p/ tag ID3. Heurística sem deps.
// 1º por script (cirílico, CJK, etc.), depois stopwords p/ línguas latinas.
function detectLang(text) {
    if (!text) return 'und'; // undetermined (ISO 639-2 válido)
    const t = text.toLowerCase();
    // scripts não-latinos: decisivos
    if (/[぀-ヿ]/.test(text)) return 'jpn';            // hiragana/katakana
    if (/[가-힯]/.test(text)) return 'kor';            // hangul
    if (/[一-鿿]/.test(text)) return 'chi';            // han
    if (/[Ѐ-ӿ]/.test(text)) return 'rus';            // cirílico
    if (/[؀-ۿ]/.test(text)) return 'ara';            // árabe
    if (/[֐-׿]/.test(text)) return 'heb';            // hebraico
    if (/[฀-๿]/.test(text)) return 'tha';            // tailandês
    if (/[Ͱ-Ͽ]/.test(text)) return 'gre';            // grego
    // línguas latinas: contagem de stopwords frequentes
    const SW = {
        por: ['que', 'não', 'você', 'com', 'uma', 'meu', 'então', 'coração', 'amor', 'pra'],
        eng: ['the', 'you', 'and', 'love', 'don\'t', 'baby', 'know', 'your', 'with', 'all'],
        spa: ['que', 'los', 'una', 'corazón', 'amor', 'porque', 'tú', 'cómo', 'siempre', 'nada'],
        fra: ['les', 'que', 'pour', 'avec', 'amour', 'cœur', 'toujours', 'moi', 'tout', 'je'],
        ita: ['che', 'non', 'amore', 'sono', 'perché', 'cuore', 'sempre', 'come', 'più', 'mio'],
        deu: ['und', 'die', 'der', 'ich', 'nicht', 'das', 'mit', 'liebe', 'ist', 'für']
    };
    const words = t.split(/[^a-zà-ÿ']+/).filter(Boolean);
    if (!words.length) return 'und';
    const set = new Set(words);
    let best = 'und', bestScore = 0;
    for (const [code, list] of Object.entries(SW)) {
        let score = 0;
        for (const w of list) if (set.has(w)) score++;
        if (score > bestScore) { bestScore = score; best = code; }
    }
    return bestScore > 0 ? best : 'und';
}

// limpa nome de arquivo: remove chars inválidos, pontos/espaços finais, limita tamanho
function sanitizeFilename(name) {
    let clean = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').trim();
    if (!clean) clean = 'track';
    if (clean.length > 120) clean = clean.slice(0, 120).trim();
    return clean;
}

// resolve colisão de nome: anexa (1), (2)... se já existir
function uniquePath(dir, base) {
    let dest = path.join(dir, `${base}.mp3`);
    let n = 1;
    while (fs.existsSync(dest)) {
        dest = path.join(dir, `${base} (${n}).mp3`);
        n++;
    }
    return dest;
}

// monta o contexto da página (igual fetchYouTubeContext) a partir do JSON do yt-dlp
function buildCtx(info, url) {
    const comments = Array.isArray(info.comments)
        ? info.comments.filter(c => c && typeof c.text === 'string').slice(0, 10)
            .map(c => c.text.replace(/\s+/g, ' ').trim()).filter(Boolean)
        : [];
    return {
        videoTitle: info.title || '',
        channel: info.uploader || info.channel || '',
        channelUrl: info.uploader_url || info.channel_url || '',
        videoUrl: info.webpage_url || url,
        description: (info.description || '').slice(0, 3000),
        tags: Array.isArray(info.tags) ? info.tags.slice(0, 25) : [],
        categories: Array.isArray(info.categories) ? info.categories : [],
        duration: info.duration_string || '',
        uploadDate: info.upload_date || '',
        comments,
        musicArtist: info.artist || '',
        musicTrack: info.track || '',
        musicAlbum: info.album || '',
        musicYear: info.release_year ? String(info.release_year)
            : (info.release_date ? String(info.release_date).slice(0, 4) : '')
    };
}

// Pipeline Gemini de 2 chamadas — réplica fiel de main.js:642-749 (modo IA).
// Retorna o objeto ID3 final, ou null em falha (chamador cai p/ factual).
async function aiEnrich(cfg, ctx, facts, factsTxt, seedArtist, seedTitle, onWait) {
    const ctxBlock = [
        `- Título do vídeo: ${ctx.videoTitle || '(desconhecido)'}`,
        `- Canal que publicou: ${ctx.channel || '(desconhecido)'}`,
        `- Link do canal: ${ctx.channelUrl || '(desconhecido)'}`,
        `- Link do vídeo: ${ctx.videoUrl || '(desconhecido)'}`,
        `- Duração: ${ctx.duration || '(desconhecida)'}`,
        `- Data de publicação (AAAAMMDD): ${ctx.uploadDate || '(desconhecida)'}`,
        `- Metadados de música do YouTube: artista=${ctx.musicArtist || '(?)'}, faixa=${ctx.musicTrack || '(?)'}, álbum=${ctx.musicAlbum || '(?)'}, ano=${ctx.musicYear || '(?)'}`,
        `- Categorias: ${(ctx.categories || []).join(', ') || '(nenhuma)'}`,
        `- Tags do vídeo: ${(ctx.tags || []).join(', ') || '(nenhuma)'}`,
        '- Descrição adicionada pelo autor:',
        (ctx.description ? ctx.description : '(sem descrição)'),
        '- Últimos comentários do vídeo:',
        ((ctx.comments && ctx.comments.length)
            ? ctx.comments.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
            : '  (nenhum comentário disponível)')
    ].join('\n');

    // ---- CHAMADA 1: análise + preenchimento de lacunas (ancorado nos fatos) ----
    const analyzeSchema = {
        type: 'object',
        properties: {
            songTitle: { type: 'string' }, primaryArtist: { type: 'string' },
            featuredArtists: { type: 'string' }, album: { type: 'string' },
            releaseYear: { type: 'string' }, genre: { type: 'string' },
            composer: { type: 'string' }, label: { type: 'string' },
            isCover: { type: 'boolean' }, originalInfo: { type: 'string' },
            comment: { type: 'string' }, confidence: { type: 'string' },
            reasoning: { type: 'string' }
        },
        required: ['songTitle', 'primaryArtist']
    };
    const analyzePrompt = [
        'Você é um especialista em catalogação musical (discografia/metadados ID3).',
        'Já consultamos APIs de serviços de música (MusicBrainz/iTunes) e elas são a FONTE',
        'PRIMÁRIA de fatos. Sua tarefa é identificar a faixa e PREENCHER O QUE FALTA.',
        '',
        'REGRA DE OURO: quando a confiança dos fatos for ALTA, NÃO contradiga álbum, ano,',
        'número da faixa, artista e título dos fatos — trate-os como verdade e apenas os adote.',
        'Quando a confiança for baixa ou faltar um campo, infira a partir do contexto do YouTube',
        '(título, canal, descrição, comentários, tags) e dos dados brutos.',
        '',
        'PARTE A — INFERÊNCIA dos campos que os fatos NÃO trazem (tipicamente: featuredArtists,',
        `composer, gênero refinado em ${t('ai.genreLanguage')}, isCover/originalInfo, comment). Pense passo a`,
        'passo internamente e resuma em "reasoning" (curto).',
        'PARTE B — RECONCILIAÇÃO com os dados brutos e o contexto, sem violar os fatos de alta confiança.',
        '',
        'Diretrizes de conteúdo:',
        '- "primaryArtist": o ARTISTA EFETIVO (use o dos fatos quando confiável; pode diferir do canal).',
        '- "featuredArtists": participações (feat./part.), separadas por vírgula, se houver.',
        '- "songTitle": apenas o nome da faixa, sem artista e sem ruído promocional.',
        '- "album"/"releaseYear": use os dos fatos quando houver; senão infira (ano com 4 dígitos).',
        `- "genre": gênero musical principal, em ${t('ai.genreLanguage')} (pode refinar/traduzir o gênero dos fatos).`,
        '- "composer": compositor(es). Se for versão/adaptação em português de canção estrangeira,',
        '  use o(s) autor(es) da VERSÃO BRASILEIRA e descreva o original em "originalInfo".',
        '- "isCover": true se for cover/versão/regravação.',
        '- "comment": curiosidade curta ou, se cover/versão, a referência ao original.',
        '- NÃO invente. Campos sem evidência suficiente devem ser "".',
        '- "confidence": "alta", "média" ou "baixa".',
        '',
        'DADOS FACTUAIS DAS APIS DE MÚSICA (fonte primária):',
        factsTxt,
        '',
        'CONTEXTO DA PÁGINA DO YOUTUBE:',
        ctxBlock,
        '',
        'DADOS BRUTOS:',
        `- Nome do arquivo: (desconhecido)`,
        `- Título atual: ${seedTitle || '(vazio)'}`,
        `- Artista atual: ${seedArtist || '(vazio)'}`,
        `- Álbum atual: (vazio)`,
        `- Título cru do vídeo: ${ctx.videoTitle || '(desconhecido)'}`,
        `- Canal: ${ctx.channel || '(desconhecido)'}`,
        `- Dica do usuário: (nenhuma)`
    ].join('\n');
    const analyzed = await gemini.callGemini(cfg, analyzePrompt, analyzeSchema, onWait);

    // ---- CHAMADA 2: consistência (fatos × análise) + normalização ID3 ----
    const normalizePrompt = [
        'Você faz a CONFERÊNCIA DE CONSISTÊNCIA entre (A) os DADOS FACTUAIS das APIs de música',
        'e (B) o OBJETO ANALISADO pelo passo anterior, e produz o JSON ID3 final.',
        '',
        'Prioridade ao resolver conflitos:',
        '- álbum, ano e número da faixa: PREFIRA os DADOS FACTUAIS quando a confiança for ALTA.',
        '- artista e título: devem ser coerentes com os fatos (de alta confiança).',
        '- gênero, compositor, comentário, participações (feat.), letra: use o OBJETO ANALISADO.',
        'Não reinterprete o conteúdo musical: apenas reconcilie, formate e distribua nos campos.',
        '',
        'Regras de normalização:',
        '- "title": nome da faixa (de "songTitle"/fatos), sem artista e sem lixo (ex.: "(Official Video)").',
        '- "artist": "primaryArtist"; se houver "featuredArtists", formate "Artista feat. Fulano, Beltrano".',
        '- "albumArtist": o artista principal do álbum (geralmente o "primaryArtist").',
        '- "album": dos fatos quando confiável; senão de "album"; senão "".',
        '- "year": exatamente 4 dígitos (dos fatos quando confiável); senão de "releaseYear"; senão "".',
        `- "genre": gênero principal em ${t('ai.genreLanguage')}, com capitalização correta.`,
        '- "composer": de "composer". Para versão brasileira, mantenha o(s) versionista(s).',
        '- "trackNumber": dos fatos quando houver; senão "". "partOfSet": só números, se houver; senão "".',
        '- "publisher": de "label", se houver; senão "".',
        '- "comment": de "comment"/"originalInfo" (se cover/versão, cite o original e autores); senão "".',
        '- "lyrics": só se já vier com alta confiança; caso contrário "".',
        '- Capitalização correta de nomes próprios. Sem aspas sobrando. Não invente dados.',
        '',
        'DADOS FACTUAIS DAS APIS DE MÚSICA:',
        factsTxt,
        '',
        'OBJETO ANALISADO:',
        JSON.stringify(analyzed, null, 2)
    ].join('\n');
    const finalData = await gemini.callGemini(cfg, normalizePrompt, gemini.ID3_SCHEMA, onWait);

    // pós-processamento determinístico: fatos de ALTA confiança mandam (main.js:744)
    if (facts && facts.confident) {
        if (facts.album) finalData.album = facts.album;
        if (facts.year) finalData.year = facts.year;
        if (facts.trackNumber) finalData.trackNumber = facts.trackNumber;
        if (facts.genre && !finalData.genre) finalData.genre = facts.genre;
    }
    return finalData;
}

// ── Gerenciamento de Progresso ──
const jobs = [];
const C = { reset: "\x1b[0m", blue: "\x1b[34m", cyan: "\x1b[36m", green: "\x1b[32m", magenta: "\x1b[35m", red: "\x1b[31m", bold: "\x1b[1m" };
let renderedLines = 0;

// render central: só chamado pelo loop do main, nunca por tracks concorrentes
function renderProgress() {
    if (renderedLines > 0) readline.moveCursor(process.stdout, 0, -renderedLines);
    jobs.forEach((job, i) => {
        const barWidth = 20;
        const pct = Math.max(0, Math.min(100, job.progress || 0));
        const filled = Math.round((pct / 100) * barWidth);
        const bar = `${C.green}${'█'.repeat(filled)}${C.reset}${'░'.repeat(barWidth - filled)}`;
        const color = job.failed ? C.red : C.magenta;
        const line = `${C.bold}${C.blue}#${i + 1}${C.reset} ${job.title.substring(0, 25).padEnd(25)} ${bar} ${color}${job.status}${C.reset}`;
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(`\x1b[K${line}\n`);
    });
    renderedLines = jobs.length;
}

// processa 1 faixa. Não escreve config (evita race) — retorna dado p/ main consolidar.
// Nunca lança: erros viram status na barra de progresso.
async function processTrack(url, index) {
    const job = jobs[index];
    let tempFile = null;
    try {
        // 1. Download info. Com IA, tenta puxar comentários (contexto p/ Gemini); fallback sem.
        const cfg = readConfig();
        cfg.apiKey = resolveApiKey(cfg); // env > config.json (secrets.enc não é legível fora do Electron)
        const useAi = aiEnabled(cfg);
        const baseInfoArgs = [url, '--no-playlist', '--skip-download', '--dump-single-json', '--js-runtime', 'node'];
        let info;
        if (useAi) {
            try {
                info = JSON.parse(execFileSync(YTDLP, [...baseInfoArgs, '--write-comments',
                    '--extractor-args', 'youtube:max_comments=10,10,0,0;comment_sort=top'], { encoding: 'utf-8' }));
            } catch { /* tenta sem comentários */ }
        }
        if (!info) info = JSON.parse(execFileSync(YTDLP, baseInfoArgs, { encoding: 'utf-8' }));
        job.title = info.title || "Musica";

        tempFile = path.join(os.tmpdir(), `syntune-${process.pid}-${index}-${Date.now()}.mp3`);
        execFileSync(YTDLP, [url, '-x', '--audio-format', 'mp3', '--ffmpeg-location', USER_DATA, '-o', tempFile, '--js-runtime', 'node']);

        // 2. Metadados — semente em camadas (igual modo factual do app main.js:589):
        // metadados de música do yt-dlp (artist/track) > parseArtistTitle(título) > parse do título cru
        job.status = "Buscando Metadados..."; job.progress = 50;
        let seedArtist = (info.artist || info.creator || '').trim();
        let seedTitle = (info.track || '').trim();
        if (!seedArtist || !seedTitle) {
            const p = parseArtistTitle(info.title);
            seedArtist = seedArtist || p.artist;
            seedTitle = seedTitle || p.title;
        }
        const seed = { artist: seedArtist, title: seedTitle };
        const facts = consolidateFacts(await gatherFacts(seed.artist || '', seed.title || info.title));

        // 2b. IA ligada: pipeline Gemini de 2 chamadas (análise + consistência). Falha → factual.
        let ai = null;
        if (useAi) {
            job.status = "Analisando (IA 1/2)..."; job.progress = 60;
            try {
                const ctx = buildCtx(info, url);
                const factsTxt = factsBlock(facts);
                const onWait = (secs, reason) => { job.status = `IA: aguardando ${secs}s (${reason})`; };
                ai = await aiEnrich(cfg, ctx, facts, factsTxt, seed.artist, seed.title, onWait);
            } catch (e) { ai = null; /* cai p/ factual */ }
        }

        // 3. Capa: Factual (Alta Resolução) ou Thumbnail do YT
        job.status = "Enriquecendo Capa..."; job.progress = 75;
        let coverBuffer = null;
        if (facts.confident) {
            try {
                const d = await fetchFactualCover(facts);
                if (d) coverBuffer = Buffer.from(d.split(',')[1], 'base64');
            } catch (e) { /* fallback para YT */ }
        }
        if (!coverBuffer && info.thumbnail) {
            try {
                const res = await fetch(info.thumbnail);
                const arrayBuffer = await res.arrayBuffer();
                coverBuffer = Buffer.from(arrayBuffer);
            } catch (e) { /* sem capa */ }
        }

        // Letra (fetchLrclib sempre retorna objeto, mas guard defensivo)
        const lyrics = (await fetchLrclib({ artist: facts.artist || seed.artist, title: facts.title || seed.title, duration: info.duration })) || {};
        // prefere SINCRONIZADA (igual app renderer.js:1210: ly.synced || ly.plain)
        const lyricText = lyrics.synced || lyrics.plain || '';

        // 4. Salvar tags. IA → usa JSON normalizado do Gemini; senão → modo factual (main.js:551).
        job.status = "Salvando..."; job.progress = 90;
        const finalArtist = (ai && ai.artist) || facts.artist || seed.artist || 'Unknown';
        const finalTitle = (ai && ai.title) || facts.title || seed.title || info.title || 'Unknown';
        const tags = ai ? {
            title: finalTitle,
            artist: finalArtist,
            album: ai.album || '',
            performerInfo: ai.albumArtist || ai.artist || '',
            year: ai.year || '',
            genre: ai.genre || '',
            trackNumber: ai.trackNumber || '',
            partOfSet: ai.partOfSet || '',
            composer: ai.composer || '',
            publisher: ai.publisher || '',
            image: coverBuffer ? { mime: 'image/jpeg', type: { id: 3, name: 'front cover' }, description: 'Cover', imageBuffer: coverBuffer } : null
        } : {
            title: finalTitle,
            artist: finalArtist,
            album: facts.album || info.album || '',
            performerInfo: facts.artist || seed.artist || '',           // albumArtist
            year: facts.year || (info.release_year ? String(info.release_year) : ''),
            genre: facts.genre || '',
            trackNumber: facts.trackNumber || '',
            image: coverBuffer ? { mime: 'image/jpeg', type: { id: 3, name: 'front cover' }, description: 'Cover', imageBuffer: coverBuffer } : null
        };
        // comentário (curiosidade/versão) só no modo IA (igual main.js:838)
        if (ai && ai.comment) {
            tags.comment = { language: detectLang(ai.comment), text: ai.comment };
        }
        // letra: IA pode trazer letra de alta confiança; senão usa LRCLIB
        const finalLyrics = (ai && ai.lyrics) ? ai.lyrics : lyricText;
        if (finalLyrics) {
            tags.unsynchronisedLyrics = { language: detectLang(finalLyrics), text: finalLyrics };
        }
        // preserva LRC sincronizada bruta no frame TXXX (igual app id3.js:52 LRCLIB_SYNC)
        if (lyrics.synced) {
            tags.userDefinedText = [{ description: 'LRCLIB_SYNC', value: lyrics.synced }];
        }

        const result = NodeID3.update(tags, tempFile);
        if (result !== true) throw new Error(`Falha ao gravar tags ID3: ${result && result.message ? result.message : result}`);

        // 5. Mover p/ destino (nome único, sanitizado)
        const downloadFolder = readConfig().downloadFolder || os.tmpdir();
        const base = sanitizeFilename(`${finalArtist} - ${finalTitle}`);
        const dest = uniquePath(downloadFolder, base);
        fs.copyFileSync(tempFile, dest);

        job.progress = 100; job.status = "Concluído";
        return { dest };
    } catch (err) {
        job.failed = true;
        job.status = `Erro: ${(err.message || err).toString().slice(0, 40)}`;
        return null;
    } finally {
        // limpa temp sempre
        if (tempFile) { try { fs.unlinkSync(tempFile); } catch { /* já removido */ } }
    }
}

// pergunta sim/não no terminal. Retorna boolean.
function askYesNo(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (ans) => {
            rl.close();
            resolve(/^s|y/i.test((ans || '').trim()));
        });
    });
}

// pega valor de uma flag: o próximo arg, desde que não seja outra flag (-x). Senão null.
function flagValue(args, flag) {
    const i = args.indexOf(flag);
    if (i === -1) return null;
    const v = args[i + 1];
    return (v && !v.startsWith('-')) ? v : null;
}

// Baixa + enriquece todas as URLs. Retorna lista de { dest } concluídos.
async function downloadAll(urls) {
    // pré-aloca jobs ANTES de qualquer render (evita cursor descompassado)
    urls.forEach((_, i) => { jobs[i] = { title: "Iniciando", progress: 0, status: "Aguardando", failed: false }; });
    process.stdout.write("\n".repeat(urls.length)); // reserva espaço
    readline.moveCursor(process.stdout, 0, -urls.length);
    renderedLines = 0;

    // loop de render central: única fonte que mexe no cursor
    const renderTimer = setInterval(renderProgress, 200);
    let results;
    try {
        results = await Promise.allSettled(urls.map((url, i) => processTrack(url, i)));
    } finally {
        clearInterval(renderTimer);
        renderProgress(); // render final
    }
    return results.map(r => (r.status === 'fulfilled' ? r.value : null)).filter(Boolean);
}

// adiciona faixas a uma playlist (cria se não existir). Escreve config 1x.
function addToPlaylist(playlistName, dests) {
    const cfg = readConfig();
    if (!Array.isArray(cfg.playlists)) cfg.playlists = [];
    let pl = cfg.playlists.find(p => p.name === playlistName);
    const created = !pl;
    if (!pl) { pl = { id: crypto.randomUUID(), name: playlistName, tracks: [] }; cfg.playlists.push(pl); }
    for (const dest of dests) if (!pl.tracks.includes(dest)) pl.tracks.push(dest);
    writeConfig(cfg);
    return created;
}

// modo lista: imprime faixas da playlist; se não existe, pergunta se quer criar.
async function listPlaylist(playlistName) {
    const cfg = readConfig();
    const pl = Array.isArray(cfg.playlists) ? cfg.playlists.find(p => p.name === playlistName) : null;
    if (!pl) {
        const create = await askYesNo(`Playlist "${playlistName}" não existe. Criar? (s/N) `);
        if (create) { addToPlaylist(playlistName, []); console.log(`Playlist "${playlistName}" criada (vazia).`); }
        else console.log("Cancelado.");
        return;
    }
    console.log(`\nPlaylist "${pl.name}" — ${pl.tracks.length} faixa(s):`);
    if (!pl.tracks.length) { console.log("  (vazia)"); return; }
    pl.tracks.forEach((tr, i) => console.log(`  ${String(i + 1).padStart(2)}. ${path.basename(tr)}`));
}

async function main() {
    const args = process.argv.slice(2);
    const hasY = args.includes('-y');
    const hasPl = args.includes('-pl');
    const urlsRaw = flagValue(args, '-y');
    const playlistName = flagValue(args, '-pl');

    // nenhum modo válido
    if (!hasY && !hasPl) {
        console.log("Uso:\n  stune -y url1,url2            baixa e enriquece (sem playlist)\n  stune -pl \"Nome\"              lista faixas da playlist (pergunta p/ criar se não existir)\n  stune -y url1,... -pl \"Nome\"  baixa, enriquece e adiciona à playlist (cria se não existir)");
        return;
    }

    // MODO LISTA: -pl sozinho (sem -y)
    if (hasPl && !hasY) {
        if (!playlistName) { console.log("Informe o nome: stune -pl \"Nome\""); return; }
        await listPlaylist(playlistName);
        return;
    }

    // MODOS DE DOWNLOAD: -y presente
    if (!urlsRaw) { console.log("Informe as URLs: stune -y url1,url2"); return; }
    const urls = urlsRaw.split(',').map(u => u.trim()).filter(Boolean);
    if (!urls.length) { console.log("Nenhuma URL válida."); return; }
    if (hasPl && !playlistName) { console.log("Nome de playlist inválido após -pl."); return; }

    const completed = await downloadAll(urls);
    const dests = completed.map(c => c.dest);

    // MODO COMPLETO: -y + -pl → adiciona à playlist (cria se não existir)
    if (hasPl && dests.length) {
        const created = addToPlaylist(playlistName, dests);
        console.log(`\n${dests.length} faixa(s) ${created ? 'na nova playlist' : 'adicionada(s) à playlist'} "${playlistName}".`);
    }

    const failed = urls.length - completed.length;
    process.stdout.write(`\n${completed.length} concluída(s)${failed ? `, ${failed} com erro` : ''}.\n`);
}

main().catch(err => { console.error('Erro fatal:', err); process.exit(1); });

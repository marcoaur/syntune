/**
 * @module  main
 * @badge   🟥 CORE · IPC-REGISTRY · CRYPTO · FS · ORCHESTRATION
 * @role    Bootstrap Electron, janela, protocolos custom, segredos cifrados, config, auto-update, e registro de TODOS os ipcMain.handle; orquestra os módulos especialistas (src/**).
 * @inputs  ciclo de vida do app, IPC do renderer (via preload), config.json/secrets.enc
 * @outputs janela, eventos IPC, arquivos em userData
 * @deps    electron, src/media/id3, src/services/{metadata-sources,gemini,lastfm}, sync-engine, i18n
 * @notes   Ainda contém: YouTube, LRCLIB, Genius, devices/sync (alvos de migração — ver AGENTS.md).
 */
const { app, BrowserWindow, ipcMain, dialog, nativeTheme, shell, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const NodeID3 = require('node-id3');
const { Readable } = require('stream');
const i18n = require('./i18n');
const t = i18n.t;

// ---------- Módulos especialistas (migração monolito → módulos) ----------
// Ver AGENTS.md (badges) e src/**/README.md (mapas de fluxo).
const { readId3Fast, lyricsText, readLrclibSync, writeLrclibSync, coverDataUrl, imagePreviewDataUrl, LRCLIB_SYNC_DESC } = require('./src/media/id3'); // 🟩 MEDIA
const { mbSearchRecordings, mbToMatches, itunesLookup, gatherFacts, consolidateFacts, fetchFactualCover, parseArtistTitle, factsBlock, fuzzyMatch, normName } = require('./src/services/metadata-sources'); // 🟦 SERVICE
const lastfm = require('./src/services/lastfm'); // 🟦 SERVICE
const createGeminiService = require('./src/services/gemini'); // 🟦 SERVICE (factory-DI)
const { ensureYtDlp, ensureFfmpeg, sanitizeName, isYouTubeUrl, fetchYouTubeContext } = require('./src/services/youtube'); // 🟦 SERVICE
const { fetchLrclib, isSyncedLyricsText, solveLrclibChallenge } = require('./src/services/lyrics-lrclib'); // 🟦 SERVICE
const { resolveArtistImage, ARTISTS_DIR } = require('./src/services/artist-image'); // 🟦 SERVICE
const { initSecrets, readRawConfig, readConfig, writeConfig, getLibraryDir, isSecureMode, SECRET_FIELDS } = require('./src/config/config-store'); // 🟪 CONFIG
const createSyncController = require('./src/devices/sync-controller'); // 🟨 DEVICE (factory-DI)

// Em modo desenvolvimento (npm start), separa o userData do app instalado para
// evitar conflitos de GPUCache/lock entre as duas instâncias.
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'syntune-dev'));
}
// Config + segredos (AES-256-GCM em repouso + safeStorage) -> src/config/config-store.js + src/config/secrets.js (🟪 CONFIG)

// Instancia o serviço Gemini injetando o acesso a config (factory-DI):
// loadGeminiUsage/persistGeminiUsage usam readConfig/writeConfig p/ persistir o RPD.
const { callGemini, loadGeminiUsage, ID3_SCHEMA } = createGeminiService({ readConfig, writeConfig });

// ---------- Janela ----------
let mainWindow;
let closingForReal = false; // o 1º close vira fade-out; o 2º fecha de verdade

function createWindow() {
  closingForReal = false;
  mainWindow = new BrowserWindow({
    width: 720,
    height: 760,
    minWidth: 560,
    minHeight: 520,
    frame: false,                    // sem moldura nativa
    titleBarStyle: 'hidden',
    backgroundColor: '#00000000',    // transparente p/ o material Mica aparecer
    backgroundMaterial: 'mica',      // barra/fundo acompanha o tema do sistema (Win11)
    roundedCorners: true,
    title: 'Syntune',
    icon: path.join(__dirname, 'src', 'img', 'icone.ico'),
    show: false,                     // evita o flash da janela vazia; exibe só quando pronta
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // mostra a janela apenas quando o conteúdo já pode ser pintado (1ª frame = splash)
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Fechamento elegante: se há música tocando, o renderer faz um fade rápido do
  // volume antes do encerramento (em vez de cortar o áudio abruptamente).
  // Cobre todos os caminhos: botão da titlebar, Alt+F4 e barra de tarefas.
  mainWindow.on('close', (e) => {
    if (closingForReal) return;
    e.preventDefault();
    mainWindow.webContents.send('app:fadeout');
    // segurança: fecha mesmo se o renderer não responder a tempo
    setTimeout(() => {
      closingForReal = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    }, 600);
  });
}

// o renderer terminou o fade do áudio: agora sim, fecha
ipcMain.on('app:fadeoutDone', () => {
  closingForReal = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

// Protocolos custom (registro único, antes do app ready):
// - mp3file:   streaming de áudio direto do disco (zero cópia via IPC)
// - mp3cover:  capa embutida do MP3 — o <img> usa o cache de imagens nativo
//              do Chromium em vez de strings base64 no heap JS
// - mp3artist: fotos de artista salvas em userData/artists/
// corsEnabled + header ACAO permitem getImageData (paleta de cores) sem
// taint do canvas.
protocol.registerSchemesAsPrivileged([
  { scheme: 'mp3file', privileges: { supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: 'mp3cover', privileges: { supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'mp3artist', privileges: { supportFetchAPI: true, corsEnabled: true } }
]);

// extrai o caminho/nome de uma URL "scheme://<encoded>?v=..." (query ignorada)
function protocolPath(url, scheme) {
  return decodeURIComponent(url.replace(new RegExp(`^${scheme}:\\/\\/`), '').split('?')[0]);
}

const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' };

// ---------- Auto-update (electron-updater via GitHub Releases) ----------
// Baixa a nova versão em segundo plano, notifica o usuário e instala ao fechar.
// Só roda no app instalado (NSIS): em dev e no build portátil o updater não se aplica.
function setupAutoUpdate() {
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  autoUpdater.on('error', (e) => console.warn('[autoUpdate]', e && e.message));

  // update baixado: o renderer mostra um badge na titlebar com a nova versão.
  // Sem clique, instala sozinho no próximo fechamento (autoInstallOnAppQuit).
  autoUpdater.on('update-downloaded', (info) => {
    send('update:ready', { version: (info && info.version) || '' });
  });

  // clique no badge: fecha e instala agora (silencioso), relançando o app
  ipcMain.on('update:install', () => {
    closingForReal = true; // pula a interceptação de fade-out do 'close'
    autoUpdater.quitAndInstall(true, true);
  });

  autoUpdater.checkForUpdates().catch(() => { /* sem rede: tenta na próxima */ });
  // re-verifica a cada 4 horas em sessões longas
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

app.whenReady().then(() => {
  // Streaming de áudio com suporte a Range (HTTP 206): essencial para o seek —
  // sem ele o Chromium não consegue reposicionar e a reprodução volta ao início.
  protocol.handle('mp3file', (request) => {
    try {
      const filePath = protocolPath(request.url, 'mp3file');
      const size = fs.statSync(filePath).size;
      const headers = {
        ...CORS_HEADERS,
        'Content-Type': 'audio/mpeg',
        'Accept-Ranges': 'bytes'
      };
      const m = /bytes=(\d*)-(\d*)/.exec(request.headers.get('Range') || '');
      if (m && (m[1] || m[2])) {
        // bytes=início-fim | bytes=início- | bytes=-sufixo
        const start = m[1] ? parseInt(m[1], 10) : Math.max(0, size - parseInt(m[2], 10));
        const end = (m[1] && m[2]) ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
        if (start >= size || start > end) return new Response(null, { status: 416, headers });
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
        headers['Content-Length'] = String(end - start + 1);
        return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), { status: 206, headers });
      }
      headers['Content-Length'] = String(size);
      return new Response(Readable.toWeb(fs.createReadStream(filePath)), { status: 200, headers });
    } catch {
      return new Response(null, { status: 404, headers: CORS_HEADERS });
    }
  });

  protocol.handle('mp3cover', (request) => {
    try {
      const filePath = protocolPath(request.url, 'mp3cover');
      if (!filePath || !fs.existsSync(filePath)) return new Response(null, { status: 404, headers: CORS_HEADERS });
      const tags = readId3Fast(filePath);
      if (!tags.image || !tags.image.imageBuffer) return new Response(null, { status: 404, headers: CORS_HEADERS });
      return new Response(tags.image.imageBuffer, {
        headers: { ...CORS_HEADERS, 'Content-Type': tags.image.mime || 'image/jpeg' }
      });
    } catch {
      return new Response(null, { status: 404, headers: CORS_HEADERS });
    }
  });

  protocol.handle('mp3artist', async (request) => {
    try {
      const name = path.basename(protocolPath(request.url, 'mp3artist')); // sem traversal
      const filePath = path.join(ARTISTS_DIR(), name);
      if (!fs.existsSync(filePath)) return new Response(null, { status: 404, headers: CORS_HEADERS });
      const res = await net.fetch(pathToFileURL(filePath).toString());
      const headers = new Headers(res.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(res.body, { status: res.status, headers });
    } catch {
      return new Response(null, { status: 404, headers: CORS_HEADERS });
    }
  });
  initSecrets(); // PRIMEIRO: ativa o cofre e migra chaves plaintext do config.json
  // resolve o idioma da interface: usa o cache do config.json ou casa o
  // locale do sistema com um arquivo em locales/ (fallback: inglês)
  i18n.init({ locale: app.getLocale(), readConfig, writeConfig });
  loadGeminiUsage(); // restaura a contagem diária (RPD) do config.json
  createWindow();
  devices.startPolling(); // monitora armazenamentos removíveis (MP4/pendrive)
  setupAutoUpdate();    // busca atualizações nas releases do GitHub
  // cofre indisponível + chaves presentes: avisa o usuário (toast na UI)
  if (!isSecureMode() && SECRET_FIELDS.some((f) => readRawConfig()[f])) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('security:plaintextWarning');
        }
      }, 3000);
    });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Limpeza de recursos antes de sair: garante que timers e workers não deixem
// o processo vivo após o fechamento da janela.
app.on('before-quit', () => {
  devices.dispose(); // para o polling de dispositivos e encerra o worker de sync
});

// ---------- IPC: controles da janela ----------
ipcMain.on('window:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('window:close', () => mainWindow && mainWindow.close());

// alterna tela cheia (usado pela tela "Tocando agora"); devolve o novo estado
ipcMain.handle('window:toggleFullscreen', () => {
  if (!mainWindow) return false;
  const full = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(full);
  return full;
});
ipcMain.handle('window:setFullscreen', (_e, on) => {
  if (!mainWindow) return false;
  mainWindow.setFullScreen(!!on);
  return mainWindow.isFullScreen();
});

// ---------- IPC: tema do sistema ----------
ipcMain.handle('theme:get', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));
nativeTheme.on('updated', () => {
  if (mainWindow) {
    mainWindow.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  }
});

// ---------- IPC: versão do app ----------
ipcMain.handle('app:getVersion', () => app.getVersion());

// ---------- IPC: idioma e textos da interface ----------
ipcMain.handle('i18n:get', () => ({ lang: i18n.getLanguage(), strings: i18n.getStrings() }));

// ---------- IPC: configuração ----------
ipcMain.handle('config:get', () => readConfig());

ipcMain.handle('config:set', (_e, cfg) => {
  const current = readConfig();
  const merged = { ...current, ...cfg };
  writeConfig(merged);
  return merged;
});

// yt-dlp/ffmpeg ensure + fetchYouTubeContext + sanitizeName/isYouTubeUrl -> src/services/youtube.js (🟦 SERVICE)

// ---------- IPC: baixar MP3 do YouTube ----------
// Aceita uma string (URL) ou um objeto { jobId, url }. O jobId acompanha os
// eventos de progresso, permitindo downloads concorrentes identificáveis na UI.
ipcMain.handle('youtube:download', async (_e, arg) => {
  const url = typeof arg === 'string' ? arg : (arg && arg.url);
  const jobId = (arg && typeof arg === 'object') ? arg.jobId || null : null;
  if (!isYouTubeUrl(url)) return { error: t('main.invalidUrl') };

  const send = (msg, percent) =>
    mainWindow && mainWindow.webContents.send('youtube:progress', { jobId, msg, percent });

  let ytDlp;
  try {
    ytDlp = await ensureYtDlp((m) => send(m));
  } catch (err) {
    return { error: t('main.ytdlpFail', { msg: err.message }) };
  }

  // 1) coletar o contexto rico da página (título, canal, descrição, comentários, tags…)
  let ytContext = null;
  let videoTitle = 'audio';
  let thumbUrl = '';
  try {
    ytContext = await fetchYouTubeContext(ytDlp, url, (m) => send(m));
    if (ytContext) {
      videoTitle = sanitizeName(ytContext.videoTitle) || 'audio';
      thumbUrl = ytContext.thumbnail || '';
    }
  } catch {
    /* segue com nome padrão */
  }

  // baixa a thumbnail (se houver) e converte em data URL para a capa
  let thumbnailDataUrl = null;
  if (thumbUrl) {
    try {
      const r = await fetch(thumbUrl);
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        const ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
        thumbnailDataUrl = `data:${ct};base64,${buf.toString('base64')}`;
      }
    } catch {
      /* sem thumbnail; segue sem capa */
    }
  }

  // 2) baixar para uma pasta temporária (arquivo "em edição")
  const tempDir = path.join(app.getPath('temp'), 'syntune');
  try { fs.mkdirSync(tempDir, { recursive: true }); } catch { /* já existe */ }
  const base = path.join(tempDir, `${videoTitle}-${Date.now()}`);
  const finalPath = `${base}.mp3`;
  // ffmpeg é obrigatório p/ extrair o áudio em mp3; baixado na 1ª vez
  let ffmpegDir = null;
  try {
    ffmpegDir = path.dirname(await ensureFfmpeg((m) => send(m)));
  } catch (err) {
    return { error: t('main.ffmpegFail', { msg: err.message }) };
  }

  // 3) baixar e extrair o áudio em mp3
  try {
    send(t('main.downloadingAudio'), 0);
    const args = [
      url,
      '--no-playlist',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '-o', `${base}.%(ext)s`
    ];
    if (ffmpegDir) args.push('--ffmpeg-location', ffmpegDir);

    await new Promise((resolve, reject) => {
      const controller = ytDlp.exec(args);
      controller.on('progress', (p) => send(t('main.downloadingAudio'), Math.round(p.percent || 0)));
      controller.on('error', reject);
      controller.on('close', resolve);
    });

    if (!fs.existsSync(finalPath)) {
      return { error: t('main.mp3NotFound') };
    }
    send(t('main.done'), 100);
    return { filePath: finalPath, videoTitle, source: 'youtube', thumbnailDataUrl, ytContext };
  } catch (err) {
    return { error: t('main.downloadFail', { msg: err.message }) };
  }
});

// ---------- IPC: seleção de arquivos ----------
ipcMain.handle('dialog:selectMp3', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: t('main.selectMp3Title'),
    properties: ['openFile'],
    filters: [{ name: t('main.mp3Filter'), extensions: ['mp3'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:selectImage', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: t('main.selectCoverTitle'),
    properties: ['openFile'],
    filters: [{ name: t('main.imagesFilter'), extensions: ['jpg', 'jpeg', 'png'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ---------- IPC: escolher a pasta padrão de downloads ----------
ipcMain.handle('dialog:selectFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: t('main.chooseFolderTitle'),
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// gera um caminho único, evitando sobrescrever (ex.: "nome (2).mp3")
function uniquePath(destPath) {
  if (!fs.existsSync(destPath)) return destPath;
  const dir = path.dirname(destPath);
  const ext = path.extname(destPath);
  const base = path.basename(destPath, ext);
  let i = 2;
  let candidate;
  do {
    candidate = path.join(dir, `${base} (${i}).${ext.replace(/^\./, '')}`);
    i++;
  } while (fs.existsSync(candidate));
  return candidate;
}

// readId3Fast → src/media/id3.js (🟩 MEDIA)

// ---------- IPC: ler tags existentes do MP3 ----------
ipcMain.handle('mp3:readTags', (_e, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) {
    return { error: t('main.fileNotFound') };
  }
  const tags = readId3Fast(filePath);
  const out = {
    fileName: path.basename(filePath),
    filePath,
    title: tags.title || '',
    artist: tags.artist || '',
    album: tags.album || '',
    albumArtist: tags.performerInfo || '',
    year: tags.year || '',
    genre: tags.genre || '',
    trackNumber: tags.trackNumber || '',
    partOfSet: tags.partOfSet || '',
    composer: tags.composer || '',
    publisher: tags.publisher || '',
    comment: tags.comment && tags.comment.text ? tags.comment.text : '',
    lyrics: lyricsText(tags),
    hasCover: !!tags.image
  };
  return out;
});

// lyricsText, LRCLIB_SYNC_DESC, readLrclibSync, writeLrclibSync → src/media/id3.js (🟩 MEDIA)

// ---------- IPC: ler/gravar tag de sincronização LRCLIB ----------
ipcMain.handle('lyrics:getSyncStatus', (_e, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return { status: null };
  return { status: readLrclibSync(filePath) };
});

ipcMain.handle('lyrics:setSyncStatus', (_e, { filePath, status }) => {
  if (!filePath || !fs.existsSync(filePath)) return { error: 'file not found' };
  writeLrclibSync(filePath, status);
  return { ok: true };
});

// ---------- IPC: listar a biblioteca (varre a pasta de músicas) ----------
ipcMain.handle('library:list', () => {
  const dir = getLibraryDir();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3'));
  } catch {
    return { dir, items: [] };
  }

  const items = names.map((name) => {
    const filePath = path.join(dir, name);
    let tags = {};
    try { tags = readId3Fast(filePath); } catch { /* ignora arquivo inválido */ }

    let mtime = 0;
    try { mtime = fs.statSync(filePath).mtimeMs; } catch { /* mantém 0 */ }

    return {
      filePath,
      fileName: name,
      title: tags.title || '',
      artist: tags.artist || '',
      album: tags.album || '',
      albumArtist: tags.performerInfo || '',
      year: tags.year || '',
      genre: tags.genre || '',
      coverDataUrl: null, // capas são servidas sob demanda pelo protocolo mp3cover://
      mtime
    };
  });

  return { dir, items };
});

// ---------- IPC: importar um MP3 local para a biblioteca ----------
ipcMain.handle('library:import', (_e, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { error: t('main.fileNotFound') };
    if (path.extname(filePath).toLowerCase() !== '.mp3') return { error: t('main.selectAnMp3') };
    const dir = getLibraryDir();
    const dest = uniquePath(path.join(dir, path.basename(filePath)));
    fs.copyFileSync(filePath, dest);
    return { success: true, filePath: dest };
  } catch (err) {
    return { error: err.message };
  }
});

// ---------- IPC: excluir uma música da biblioteca ----------
ipcMain.handle('library:delete', (_e, filePath) => {
  try {
    const dir = path.resolve(getLibraryDir());
    // segurança: só permite excluir arquivos dentro da pasta da biblioteca
    if (path.dirname(path.resolve(filePath)) !== dir) {
      return { error: t('main.outsideLibrary') };
    }
    fs.unlinkSync(filePath);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

// ---------- IPC: capa do MP3 como data URL (lazy, sob demanda) ----------
ipcMain.handle('mp3:cover', (_e, filePath) => coverDataUrl(filePath));

// ---------- IPC: ler imagem como data URL (preview) ----------
ipcMain.handle('image:preview', (_e, imagePath) => imagePreviewDataUrl(imagePath));

// Gemini engine (rate-limit por modelo + callGemini + ID3_SCHEMA) -> src/services/gemini.js (factory-DI)

// ---------- IPC: pipeline inteligente (fontes factuais + 2 chamadas ao Gemini) ----------
// 0) FONTES FACTUAIS: MusicBrainz + iTunes a partir de uma semente artista/título.
// 1) ANÁLISE + LACUNAS: com o contexto do YouTube E os fatos já obtidos, o Gemini
//    identifica a faixa e preenche o que falta (sem contradizer fatos de alta confiança).
// 2) CONSISTÊNCIA + NORMALIZAÇÃO: cruza os fatos com a análise e entrega o ID3 final.
// Continua limitado a 2 requisições ao Gemini/música (rate-limited).
// Monta os metadados ID3 só com os FATOS (MusicBrainz/iTunes) — sem IA.
// Usado no modo factual (sem chave Gemini): qualidade vem das fontes factuais;
// a IA só preencheria lacunas/normalizaria títulos sujos.
function factualMetadata(facts, seedArtist, seedTitle, raw) {
  facts = facts || {};
  raw = raw || {};
  return {
    title: facts.title || seedTitle || raw.title || '',
    artist: facts.artist || seedArtist || raw.artist || '',
    album: facts.album || raw.album || '',
    albumArtist: facts.artist || seedArtist || '',
    year: facts.year || '',
    genre: facts.genre || '',
    trackNumber: facts.trackNumber || '',
    partOfSet: '',
    composer: '',
    publisher: '',
    comment: '',
    lyrics: ''
  };
}

// IA ligada? Precisa de chave E não ter sido desativada explicitamente (useAi=false).
// Sem chave → modo factual automático (o app funciona p/ qualquer um, sem config).
function aiEnabled(cfg) { return cfg.useAi !== false && !!cfg.apiKey; }

ipcMain.handle('gemini:smartMetadata', async (_e, payload) => {
  const cfg = readConfig();

  const ctx = (payload && payload.ytContext) || {};
  const raw = (payload && payload.raw) || {};
  const hint = (payload && payload.hint) || '';
  const jobId = (payload && payload.jobId) || null;

  // o payload leva flags estruturadas (step/waiting) para o renderer não
  // depender do texto da mensagem (que agora é traduzido)
  const progress = (msg, extra) =>
    mainWindow && mainWindow.webContents.send('gemini:progress', { jobId, msg, ...(extra || {}) });
  const waitNotice = (label) => (secs, reason) =>
    progress(t('main.waiting', { label, reason, secs }), { waiting: true });

  // ---- ETAPA 0: semente + fontes factuais (MusicBrainz + iTunes) ----
  let seedArtist = (raw.artist || '').trim() || (ctx.musicArtist || '').trim();
  let seedTitle = (raw.title || '').trim() || (ctx.musicTrack || '').trim();
  if ((!seedArtist || !seedTitle) && ctx.videoTitle) {
    const p = parseArtistTitle(ctx.videoTitle);
    seedArtist = seedArtist || p.artist;
    seedTitle = seedTitle || p.title;
  }
  if ((!seedArtist || !seedTitle) && raw.fileName) {
    const p = parseArtistTitle(String(raw.fileName).replace(/\.mp3$/i, ''));
    seedArtist = seedArtist || p.artist;
    seedTitle = seedTitle || p.title;
  }

  progress(t('main.queryingSources'));
  let facts = {};
  try { facts = consolidateFacts(await gatherFacts(seedArtist, seedTitle)); } catch { facts = {}; }
  const factsTxt = factsBlock(facts);

  // ---- MODO FACTUAL (sem IA): devolve os fatos direto + capa, pulando o Gemini ----
  if (!aiEnabled(cfg)) {
    let coverDataUrl = null;
    if (facts && facts.confident) {
      progress(t('main.fetchingCover'));
      try { coverDataUrl = await fetchFactualCover(facts); } catch { /* sem capa factual */ }
    }
    return {
      data: factualMetadata(facts, seedArtist, seedTitle, raw),
      coverDataUrl,
      sources: (facts && facts.sources) || [],
      aiSkipped: true
    };
  }

  // Bloco com todo o contexto da página, reutilizado nas chamadas.
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

  try {
    // ---- CHAMADA 1: análise + preenchimento de lacunas (ancorado nos fatos) ----
    progress(t('main.step1'), { step: 1 });
    const analyzeSchema = {
      type: 'object',
      properties: {
        songTitle: { type: 'string' },
        primaryArtist: { type: 'string' },
        featuredArtists: { type: 'string' },
        album: { type: 'string' },
        releaseYear: { type: 'string' },
        genre: { type: 'string' },
        composer: { type: 'string' },
        label: { type: 'string' },
        isCover: { type: 'boolean' },
        originalInfo: { type: 'string' },
        comment: { type: 'string' },
        confidence: { type: 'string' },
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
      `- Nome do arquivo: ${raw.fileName || '(desconhecido)'}`,
      `- Título atual: ${raw.title || '(vazio)'}`,
      `- Artista atual: ${raw.artist || '(vazio)'}`,
      `- Álbum atual: ${raw.album || '(vazio)'}`,
      `- Título cru do vídeo: ${ctx.videoTitle || '(desconhecido)'}`,
      `- Canal: ${ctx.channel || '(desconhecido)'}`,
      `- Dica do usuário: ${hint || '(nenhuma)'}`
    ].join('\n');
    const analyzed = await callGemini(cfg, analyzePrompt, analyzeSchema, waitNotice('1/2'));

    // ---- CHAMADA 2: consistência (fatos × análise) + normalização ID3 ----
    progress(t('main.step2'), { step: 2 });
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
    const finalData = await callGemini(cfg, normalizePrompt, ID3_SCHEMA, waitNotice('2/2'));

    // pós-processamento determinístico: fatos de ALTA confiança mandam nos campos objetivos
    if (facts && facts.confident) {
      if (facts.album) finalData.album = facts.album;
      if (facts.year) finalData.year = facts.year;
      if (facts.trackNumber) finalData.trackNumber = facts.trackNumber;
      if (facts.genre && !finalData.genre) finalData.genre = facts.genre;
    }

    // capa factual em alta (CAA/iTunes), só quando o match é confiável
    let coverDataUrl = null;
    if (facts && facts.confident) {
      progress(t('main.fetchingCover'));
      try { coverDataUrl = await fetchFactualCover(facts); } catch { /* sem capa factual */ }
    }

    return { data: finalData, coverDataUrl, sources: (facts && facts.sources) || [], debug: { analyzed, facts } };
  } catch (err) {
    return { error: err.message || t('main.pipelineFail') };
  }
});

// ---------- IPC: buscar metadados via Gemini (chamada única — arquivos locais) ----------
ipcMain.handle('gemini:fetchMetadata', async (_e, context) => {
  const cfg = readConfig();
  context = context || {};

  // Modo factual (sem IA): semente a partir das tags atuais → MusicBrainz/iTunes.
  if (!aiEnabled(cfg)) {
    let seedArtist = (context.artist || '').trim();
    let seedTitle = (context.title || '').trim();
    if ((!seedArtist || !seedTitle) && context.fileName) {
      const p = parseArtistTitle(String(context.fileName).replace(/\.mp3$/i, ''));
      seedArtist = seedArtist || p.artist;
      seedTitle = seedTitle || p.title;
    }
    let facts = {};
    try { facts = consolidateFacts(await gatherFacts(seedArtist, seedTitle)); } catch { facts = {}; }
    return { data: factualMetadata(facts, seedArtist, seedTitle, context), sources: (facts && facts.sources) || [], aiSkipped: true };
  }

  const prompt = [
    'Você é um especialista em catalogação musical (discografia/metadados ID3).',
    'A partir das informações fornecidas sobre um arquivo de áudio, identifique a faixa e retorne os metadados mais precisos possíveis.',
    'Regras importantes:',
    '- NÃO invente dados. Se não tiver certeza de um campo, deixe-o como string vazia "".',
    '- "year" deve ter 4 dígitos (ano de lançamento da gravação/álbum).',
    '- "trackNumber" e "partOfSet" apenas números (ex: "3" ou "1/2") quando souber.',
    `- "genre" use o gênero principal em ${t('ai.genreLanguage')} quando aplicável.`,
    '- "composer": preencha com o(s) compositor(es) da canção.',
    '- IMPORTANTE: se a faixa for uma versão/adaptação em português de uma canção estrangeira,',
    '  preencha "composer" com o(s) autor(es) da VERSÃO BRASILEIRA (o versionista/adaptador brasileiro),',
    '  e em "comment" cite o título e o(s) compositor(es) originais (ex: "Versão de \'Title\' (Autor Original)").',
    '- "comment" pode trazer essa informação de adaptação ou uma curiosidade curta; caso contrário "".',
    '- "lyrics" só preencha se tiver alta confiança; caso contrário "".',
    '',
    'Dados conhecidos do arquivo:',
    `- Nome do arquivo: ${context.fileName || '(desconhecido)'}`,
    `- Título atual: ${context.title || '(vazio)'}`,
    `- Artista atual: ${context.artist || '(vazio)'}`,
    `- Álbum atual: ${context.album || '(vazio)'}`,
    `- Dica do usuário: ${context.hint || '(nenhuma)'}`
  ].join('\n');

  try {
    const parsed = await callGemini(cfg, prompt, ID3_SCHEMA);
    return { data: parsed };
  } catch (err) {
    return { error: err.message || t('main.connectionFail') };
  }
});

// ---------- IPC: salvar tags no MP3 ----------
// origem 'file'    -> sobrescreve o arquivo original.
// origem 'youtube' -> grava no arquivo temporário e abre "Salvar como"
//                     (nome sugerido pela música) para o destino final.
ipcMain.handle('mp3:saveTags', async (_e, payload) => {
  const { filePath, fields, imagePath, imageDataUrl, source, suggestedName } = payload;
  if (!filePath || !fs.existsSync(filePath)) {
    return { error: t('main.mp3NotFoundFile') };
  }

  const tags = {
    title: fields.title || '',
    artist: fields.artist || '',
    album: fields.album || '',
    performerInfo: fields.albumArtist || '',
    year: fields.year || '',
    genre: fields.genre || '',
    trackNumber: fields.trackNumber || '',
    partOfSet: fields.partOfSet || '',
    composer: fields.composer || '',
    publisher: fields.publisher || ''
  };

  // sempre grava (mesmo vazio) para permitir LIMPAR um comentário/letra existente
  tags.comment = { language: 'por', text: fields.comment || '' };
  tags.unsynchronisedLyrics = { language: 'por', text: fields.lyrics || '' };

  // preserva frames TXXX existentes (especialmente LRCLIB_SYNC) e aplica o novo status
  const existingTxxx = (() => {
    try {
      const t = readId3Fast(filePath);
      const arr = t.userDefinedText || [];
      return Array.isArray(arr) ? arr : [arr];
    } catch { return []; }
  })();
  if (fields.lrclibSync !== undefined && fields.lrclibSync !== null) {
    const others = existingTxxx.filter((x) => x && x.description !== LRCLIB_SYNC_DESC);
    tags.userDefinedText = [...others, { description: LRCLIB_SYNC_DESC, value: fields.lrclibSync }];
  } else {
    // preserva sem alterar
    if (existingTxxx.length) tags.userDefinedText = existingTxxx;
  }

  // capa: prioriza a imagem enquadrada (data URL vinda do recorte); senão, caminho local
  let coverBuffer = null;
  let coverMime = 'image/jpeg';
  if (imageDataUrl && imageDataUrl.startsWith('data:')) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(imageDataUrl);
    if (m) {
      coverMime = m[1] || 'image/jpeg';
      coverBuffer = Buffer.from(m[2], 'base64');
    }
  } else if (imagePath && fs.existsSync(imagePath)) {
    const ext = path.extname(imagePath).toLowerCase();
    coverMime = ext === '.png' ? 'image/png' : 'image/jpeg';
    coverBuffer = fs.readFileSync(imagePath);
  }
  if (coverBuffer) {
    tags.image = {
      mime: coverMime,
      type: { id: 3, name: 'front cover' },
      description: 'Cover',
      imageBuffer: coverBuffer
    };
  }

  try {
    const ok = NodeID3.update(tags, filePath);
    if (ok !== true) return { error: t('main.tagsWriteFail') };
  } catch (err) {
    return { error: t('main.saveError', { msg: err.message }) };
  }

  // origem arquivo local: já gravou sobre o original
  if (source === 'file') {
    return { success: true, savedPath: filePath };
  }

  // origem biblioteca: move o temporário para a pasta de músicas, sem diálogo
  if (source === 'library') {
    const dir = getLibraryDir();
    const dest = uniquePath(path.join(dir, sanitizeName(suggestedName) + '.mp3'));
    try {
      fs.copyFileSync(filePath, dest);
      fs.unlink(filePath, () => {}); // remove o temporário (best-effort)
      return { success: true, savedPath: dest };
    } catch (err) {
      return { error: t('main.saveLibraryError', { msg: err.message }) };
    }
  }

  // origem YouTube: escolher destino final, com o nome da música pré-preenchido
  const defaultName = sanitizeName(suggestedName) + '.mp3';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: t('main.saveAsTitle'),
    defaultPath: path.join(app.getPath('music') || app.getPath('downloads'), defaultName),
    filters: [{ name: t('main.mp3Filter'), extensions: ['mp3'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  const dest = result.filePath.toLowerCase().endsWith('.mp3')
    ? result.filePath
    : result.filePath + '.mp3';

  try {
    fs.copyFileSync(filePath, dest);
    fs.unlink(filePath, () => {}); // remove o temporário (best-effort)
    return { success: true, savedPath: dest };
  } catch (err) {
    return { error: t('main.saveDestError', { msg: err.message }) };
  }
});

// MusicBrainz/iTunes facts -> src/services/metadata-sources.js (🟦)
// LRCLIB lyrics (get/search/fetchLrclib/PoW) -> src/services/lyrics-lrclib.js (🟦)

ipcMain.handle('lyrics:fetchSynced', async (_e, args = {}) => {
  try {
    if (!args.title && !args.artist) return { error: t('main.titleArtistRequired') };
    return await fetchLrclib(args);
  } catch (err) {
    return { error: err.message || t('main.lyricsFetchFail') };
  }
});

// Etapa de enriquecimento: busca a letra (preferindo a sincronizada) e grava no arquivo,
// sem tocar nas demais tags. Não sobrescreve uma letra sincronizada já existente.
ipcMain.handle('lyrics:enrichFile', async (_e, { filePath } = {}) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { error: t('main.fileNotFound') };
    const tags = readId3Fast(filePath);
    if (isSyncedLyricsText(lyricsText(tags))) return { written: false, skipped: true };
    const res = await fetchLrclib({
      artist: tags.artist || '', title: tags.title || '',
      album: tags.album || '', duration: 0
    });
    const text = res.synced || res.plain;
    if (!text) return { written: false };
    NodeID3.update({ unsynchronisedLyrics: { language: 'por', text } }, filePath);
    return { written: true, synced: !!res.synced };
  } catch (err) {
    return { error: err.message };
  }
});

// ---------- IPC: foto do artista (Genius) → src/services/artist-image.js (🟦 SERVICE) ----------
ipcMain.handle('artist:image', (_e, { name } = {}) =>
  resolveArtistImage({ name, token: readConfig().geniusToken, noArtistLabel: t('library.noArtist') }));

// Last.fm (assinatura MD5, auth web-flow, scrobble, playcount, artist info)
// → src/services/lastfm.js (🟦 SERVICE). Handlers só leem cfg e injetam as chaves.
ipcMain.handle('lastfm:authSession', (_e, { apiKey, secret }) => lastfm.authSession({ apiKey, secret }));

ipcMain.handle('lastfm:scrobble', (_e, { artist, title, timestamp }) => {
  const cfg = readConfig();
  if (!cfg.lastfmScrobbleEnabled || !cfg.lastfmSessionKey || !cfg.lastfmApiKey || !cfg.lastfmSecret) return { success: false };
  return lastfm.scrobble({
    apiKey: cfg.lastfmApiKey, secret: cfg.lastfmSecret, sessionKey: cfg.lastfmSessionKey,
    artist, title, timestamp
  });
});

ipcMain.handle('lastfm:getPlaycount', (_e, { artist, title } = {}) => {
  const cfg = readConfig();
  return lastfm.getPlaycount({ apiKey: cfg.lastfmApiKey, artist, title });
});

ipcMain.handle('lastfm:getArtistInfo', (_e, { artist } = {}) => {
  const cfg = readConfig();
  return lastfm.getArtistInfo({ apiKey: cfg.lastfmApiKey, artist });
});


ipcMain.handle('lyrics:publish', async (_e, payload) => {
  const { trackName, artistName, albumName, duration, plainLyrics, syncedLyrics, filePath } = payload;
  if (!trackName || !artistName || !duration) return { error: 'Campos obrigatórios ausentes' };

  const token = await solveLrclibChallenge();
  if (!token) return { error: 'Falha ao gerar o token de contribuição (PoW).' };

  const body = {
    trackName,
    artistName,
    albumName: albumName || '',
    duration: Math.round(duration),
    plainLyrics: plainLyrics || '',
    syncedLyrics: syncedLyrics || ''
  };

  try {
    const res = await fetch('https://lrclib.net/api/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Publish-Token': token
      },
      body: JSON.stringify(body)
    });
    
    if (res.ok || res.status === 201) {
      // Marca o arquivo como sincronizado com o LRCLIB
      if (filePath && fs.existsSync(filePath)) {
        writeLrclibSync(filePath, 'synced');
      }
      return { success: true };
    } else {
      let msg = 'Erro na API LRCLIB';
      try { const r = await res.json(); msg = r.message || r.error || msg; } catch {}
      return { error: msg };
    }
  } catch (err) {
    return { error: err.message };
  }
});

// ====================================================================
// Sincronização com dispositivo de armazenamento (MP4/pendrive USB)
// ====================================================================

// envia um evento ao renderer com proteção contra janela já destruída
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------- Detecção + sincronização de dispositivos -> src/devices/{device-detection,sync-controller}.js (🟨 DEVICE) ----------
const devices = createSyncController({ send, readConfig, writeConfig, getLibraryDir, readId3Fast });
// destructure com MESMOS nomes -> handlers abaixo inalterados
const { connectedDevices, deviceMusicDir, readSyncState, writeSyncState, syncKey, scanDevice, syncDevice, runSyncTask, SYNC_PATH } = devices;

// ---------- IPC: dispositivos e sincronização ----------
ipcMain.handle('devices:list', () => {
  const cfg = readConfig();
  const devices = cfg.devices || {};
  const out = Object.keys(devices).map((serial) => {
    const e = devices[serial];
    const conn = connectedDevices.get(serial);
    return {
      serial,
      nickname: e.nickname || '',
      syncEnabled: !!e.syncEnabled,
      ignored: !!e.ignored,
      configured: !!e.configured,
      usedVolumeFallback: !!e.usedVolumeFallback,
      connected: !!conn,
      drive: conn ? conn.drive : '',
      label: conn ? conn.label : (e.lastLabel || ''),
      free: conn ? conn.free : 0,
      size: conn ? conn.size : 0,
      syncScope: (e.syncScope && e.syncScope.mode === 'artists')
        ? { mode: 'artists', artists: Array.isArray(e.syncScope.artists) ? e.syncScope.artists : [] }
        : { mode: 'all' }
    };
  });
  return { devices: out };
});

ipcMain.handle('devices:update', (_e, payload) => {
  const serial = payload && payload.serial;
  if (!serial) return { error: t('main.serialMissing') };
  const cfg = readConfig();
  cfg.devices = cfg.devices || {};
  const e = cfg.devices[serial] || { serial, nickname: '', syncEnabled: false, ignored: false, configured: false };
  if (payload.nickname != null) {
    e.nickname = String(payload.nickname).trim();
    if (e.nickname) e.configured = true;
  }
  if (payload.syncEnabled != null) {
    e.syncEnabled = !!payload.syncEnabled;
    if (e.syncEnabled) e.configured = true; // ligar a sync já configura o dispositivo
  }
  if (payload.syncScope != null) {
    e.syncScope = (payload.syncScope && payload.syncScope.mode === 'artists')
      ? { mode: 'artists', artists: Array.isArray(payload.syncScope.artists) ? payload.syncScope.artists : [] }
      : { mode: 'all' };
  }
  if (payload.ignored != null) e.ignored = !!payload.ignored;
  cfg.devices[serial] = e;
  writeConfig(cfg);
  return { device: { ...e, connected: connectedDevices.has(serial) } };
});

ipcMain.handle('device:scan', (_e, { serial }) => {
  // o worker emite um único objeto { msg, percent, current, done, total }
  const onProgress = (p) => send('sync:progress', { serial, phase: 'scan', ...p });
  return scanDevice(serial, onProgress);
});

ipcMain.handle('device:sync', (_e, { serial }) => {
  const onProgress = (p) => send('sync:progress', { serial, phase: 'sync', ...p });
  return syncDevice(serial, onProgress);
});

// chaves das faixas presentes no dispositivo (lê o novo formato { keys, bySrc }
// com compatibilidade ao formato antigo, que era um mapa plano de chaves)
function deviceSyncedKeys(st, serial) {
  const e = st[serial];
  if (!e || typeof e !== 'object') return [];
  if (e.keys && typeof e.keys === 'object') return Object.keys(e.keys);
  return Object.keys(e).filter((k) => k !== 'keys' && k !== 'bySrc');
}

ipcMain.handle('device:syncState', (_e, { serial }) => {
  const st = readSyncState();
  return { serial, keys: deviceSyncedKeys(st, serial) };
});

// exporta uma playlist como arquivo .m3u8 no PC (diálogo "Salvar como")
ipcMain.handle('playlist:exportM3u', async (_e, { name, tracks } = {}) => {
  try {
    if (!Array.isArray(tracks) || !tracks.length) return { error: t('main.playlistEmpty') };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: t('main.exportPlaylistTitle'),
      defaultPath: path.join(app.getPath('music') || app.getPath('downloads'), sanitizeName(name || 'playlist') + '.m3u8'),
      filters: [{ name: t('main.playlistFilter'), extensions: ['m3u8', 'm3u'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    let body = '#EXTM3U\n';
    for (const t of tracks) {
      if (!t || !fs.existsSync(t)) continue;
      let label = path.basename(t);
      try {
        const tags = readId3Fast(t);
        const l = `${tags.artist || ''} - ${tags.title || ''}`.replace(/^ - | - $/g, '').trim();
        if (l) label = l;
      } catch { /* usa o nome do arquivo */ }
      body += `#EXTINF:-1,${label}\n${t}\n`; // caminhos absolutos (portável p/ outros players)
    }
    fs.writeFileSync(result.filePath, body, 'utf-8');
    return { success: true, path: result.filePath };
  } catch (err) {
    return { error: err.message };
  }
});

// sincroniza uma playlist no dispositivo (copia faixas faltantes + grava .m3u8)
ipcMain.handle('playlist:syncToDevice', (_e, { serial, name, tracks } = {}) => {
  const d = connectedDevices.get(serial);
  if (!d) return { error: t('main.deviceNotConnected') };
  const onProgress = (p) => send('sync:progress', { serial, phase: 'playlist', ...p });
  return runSyncTask('playlist', {
    serial, musicDir: deviceMusicDir(serial), libraryDir: getLibraryDir(),
    syncPath: SYNC_PATH(), free: d.free || 0, tracks: tracks || [], name: name || 'playlist'
  }, onProgress);
});

// Exclui a cópia de uma faixa no dispositivo. Aceita o caminho direto (faixa que
// só existe no dispositivo) ou o caminho do arquivo no PC (resolve o destino pelo
// vínculo em sync.json). Limpa o estado e remove a pasta de artista se ficar vazia.
ipcMain.handle('device:deleteTrack', (_e, { serial, pcFilePath, deviceFilePath } = {}) => {
  try {
    const musicDir = deviceMusicDir(serial);
    if (!musicDir) return { error: t('main.deviceNotConnected') };
    const st = readSyncState();
    const e = st[serial];

    let target = deviceFilePath || null;
    let key = null;
    if (!target && pcFilePath && e && e.bySrc && e.bySrc[pcFilePath]) {
      target = path.join(musicDir, e.bySrc[pcFilePath].deviceRel);
      key = e.bySrc[pcFilePath].key;
    }

    if (target) {
      const resolved = path.resolve(target);
      const base = path.resolve(musicDir);
      if (resolved !== base && !resolved.startsWith(base + path.sep)) return { error: t('main.pathOutsideDevice') };
      if (!key) { try { const t = readId3Fast(target); key = syncKey(t.title || '', t.artist || '', t.year || ''); } catch { /* sem tags */ } }
      try { fs.unlinkSync(target); } catch { /* talvez já removido */ }
      // remove a pasta do artista se ficou vazia
      try {
        const dir = path.dirname(resolved);
        if (dir !== path.resolve(musicDir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch { /* ignora */ }
    }

    // limpa o estado (keys + vínculo)
    if (e) {
      if (pcFilePath && e.bySrc) delete e.bySrc[pcFilePath];
      if (key && e.keys) delete e.keys[key];
      writeSyncState(st);
    }
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Traz uma faixa que só existe no dispositivo para a biblioteca do PC e a REMOVE
// do dispositivo. Assim, após o usuário enriquecê-la, a próxima sincronização copia
// apenas a versão atualizada — sem deixar duas cópias com metadados divergentes.
ipcMain.handle('device:enrichFromDevice', (_e, { serial, filePath }) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { error: t('main.fileNotFoundOnDevice') };
    const dir = getLibraryDir();
    const dest = uniquePath(path.join(dir, path.basename(filePath)));
    fs.copyFileSync(filePath, dest);

    // remove o original do dispositivo e limpa sua entrada no sync.json
    let tags = {};
    try { tags = readId3Fast(filePath); } catch { /* sem tags */ }
    try { fs.unlinkSync(filePath); } catch { /* best-effort */ }
    if (serial) {
      const st = readSyncState();
      const e = st[serial];
      if (e) {
        const k = syncKey(tags.title || '', tags.artist || '', tags.year || '');
        if (e.keys && typeof e.keys === 'object') delete e.keys[k]; // novo formato
        else delete e[k];                                           // formato antigo
        writeSyncState(st);
      }
    }
    return { success: true, filePath: dest };
  } catch (err) {
    return { error: err.message };
  }
});

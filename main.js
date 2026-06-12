const { app, BrowserWindow, ipcMain, dialog, nativeTheme, shell, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { Worker } = require('worker_threads');
const NodeID3 = require('node-id3');
const YTDlpWrap = require('yt-dlp-wrap').default;
const { createGunzip } = require('zlib');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const i18n = require('./i18n');
const t = i18n.t;

// Em modo desenvolvimento (npm start), separa o userData do app instalado para
// evitar conflitos de GPUCache/lock entre as duas instâncias.
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'syntune-dev'));
}
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf-8'));
  } catch {
    return { apiKey: '', lastfmApiKey: '', geniusToken: '', model: 'gemini-2.5-flash', downloadFolder: '' };
  }
}

// Pasta onde a biblioteca de músicas é guardada.
// Usa a pasta configurada pelo usuário; se não houver (ou se o caminho estiver
// inacessível — unidade removida, caminho de rede, sem permissão), cai na pasta
// temporária para não travar o startup.
function getLibraryDir() {
  const cfg = readConfig();
  const configured = cfg.downloadFolder && cfg.downloadFolder.trim();
  const fallback = path.join(app.getPath('temp'), 'syntune', 'library');

  if (configured) {
    try {
      fs.mkdirSync(configured, { recursive: true });
      // Verifica acesso de leitura/escrita rapidamente
      fs.accessSync(configured, fs.constants.R_OK | fs.constants.W_OK);
      return configured;
    } catch {
      // Caminho inacessível: usa pasta temporária como fallback seguro
      console.warn('[getLibraryDir] Pasta configurada inacessível, usando fallback:', configured);
    }
  }

  try { fs.mkdirSync(fallback, { recursive: true }); } catch { /* já existe */ }
  return fallback;
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(cfg, null, 2), 'utf-8');
}

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
  autoUpdater.checkForUpdatesAndNotify().catch(() => { /* sem rede: tenta na próxima */ });
  // re-verifica a cada 4 horas em sessões longas
  setInterval(() => autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 4 * 60 * 60 * 1000);
}

app.whenReady().then(() => {
  protocol.handle('mp3file', async (request) => {
    const filePath = protocolPath(request.url, 'mp3file');
    const res = await net.fetch(pathToFileURL(filePath).toString());
    const headers = new Headers(res.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(res.body, { status: res.status, headers });
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
  // resolve o idioma da interface: usa o cache do config.json ou casa o
  // locale do sistema com um arquivo em locales/ (fallback: inglês)
  i18n.init({ locale: app.getLocale(), readConfig, writeConfig });
  loadGeminiUsage(); // restaura a contagem diária (RPD) do config.json
  createWindow();
  startDevicePolling(); // monitora armazenamentos removíveis (MP4/pendrive)
  setupAutoUpdate();    // busca atualizações nas releases do GitHub
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
  // Para o polling de dispositivos
  if (devicePollTimer) { clearInterval(devicePollTimer); devicePollTimer = null; }
  // Encerra o worker de sincronização
  if (syncWorker) { try { syncWorker.terminate(); } catch { /* ok */ } syncWorker = null; }
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

// ---------- YouTube: binário do yt-dlp (download único na 1ª vez) ----------
const YTDLP_PATH = () =>
  path.join(app.getPath('userData'), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

// guarda para evitar download duplicado do binário quando 2 jobs iniciam juntos
let ytDlpDownloadPromise = null;
async function ensureYtDlp(onStatus) {
  const bin = YTDLP_PATH();
  if (!fs.existsSync(bin)) {
    if (onStatus) onStatus(t('main.preparingDownloader'));
    if (!ytDlpDownloadPromise) {
      ytDlpDownloadPromise = YTDlpWrap.downloadFromGithub(bin)
        .finally(() => { ytDlpDownloadPromise = null; });
    }
    await ytDlpDownloadPromise;
  }
  return new YTDlpWrap(bin);
}

// ---------- ffmpeg: binário baixado na 1ª vez (como o yt-dlp) ----------
// Substitui o ffmpeg-static empacotado (~79 MB no instalador). Baixa o MESMO
// binário, do mesmo release do ffmpeg-static no GitHub, para o userData.
const FFMPEG_RELEASE = 'b6.1.1';
const FFMPEG_PATH = () =>
  path.join(app.getPath('userData'), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

// guarda para evitar download duplicado quando 2 jobs iniciam juntos
let ffmpegDownloadPromise = null;
async function ensureFfmpeg(onStatus) {
  const bin = FFMPEG_PATH();
  if (fs.existsSync(bin)) return bin;
  if (onStatus) onStatus(t('main.preparingConverter'));
  if (!ffmpegDownloadPromise) {
    ffmpegDownloadPromise = (async () => {
      const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_RELEASE}/ffmpeg-${process.platform}-${process.arch}.gz`;
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      // grava num .download e renomeia no fim: nunca deixa um binário pela metade
      const tmp = bin + '.download';
      await pipeline(Readable.fromWeb(res.body), createGunzip(), fs.createWriteStream(tmp));
      if (process.platform !== 'win32') fs.chmodSync(tmp, 0o755);
      fs.renameSync(tmp, bin);
      return bin;
    })().finally(() => { ffmpegDownloadPromise = null; });
  }
  return ffmpegDownloadPromise;
}

function sanitizeName(name) {
  return (name || 'audio').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 120) || 'audio';
}

function isYouTubeUrl(url) {
  return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\//i.test(url || '');
}

// Coleta o contexto rico da página do YouTube para alimentar o pipeline do Gemini:
// título, canal, link, descrição do autor, tags/categorias e os ~10 comentários
// do topo. (Obs.: "vídeos relacionados" não são expostos pelo yt-dlp de forma
// confiável; as tags/categorias cumprem papel semelhante de sinal de contexto.)
async function fetchYouTubeContext(ytDlp, url, onStatus) {
  if (onStatus) onStatus(t('main.readingYouTube'));

  const baseArgs = [url, '--no-playlist', '--skip-download', '--dump-single-json'];

  let info = null;
  // 1ª tentativa: com comentários (pode ser mais lento / às vezes bloqueado)
  try {
    const out = await ytDlp.execPromise([
      ...baseArgs,
      '--write-comments',
      '--extractor-args', 'youtube:max_comments=10,10,0,0;comment_sort=top'
    ]);
    info = JSON.parse(out);
  } catch {
    /* tenta sem comentários abaixo */
  }
  // fallback: sem comentários
  if (!info) {
    try {
      const out = await ytDlp.execPromise(baseArgs);
      info = JSON.parse(out);
    } catch {
      return null; // segue sem contexto rico
    }
  }

  const comments = Array.isArray(info.comments)
    ? info.comments
        .filter((c) => c && typeof c.text === 'string')
        .slice(0, 10)
        .map((c) => c.text.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
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
    thumbnail: (info.thumbnail || '').startsWith('http') ? info.thumbnail : '',
    // metadados de música expostos pelo YouTube Music (quando houver) — boa semente
    musicArtist: info.artist || '',
    musicTrack: info.track || '',
    musicAlbum: info.album || '',
    musicYear: info.release_year ? String(info.release_year)
      : (info.release_date ? String(info.release_date).slice(0, 4) : '')
  };
}

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

// Lê as tags ID3 de forma rápida: em vez de carregar o arquivo inteiro
// (o que trava em MP3s grandes/com capa), lê só a região do cabeçalho ID3v2,
// que fica no início do arquivo. Cai para a leitura completa apenas quando
// não há ID3v2 no início (ex.: somente ID3v1 no fim).
function readId3Fast(filePath) {
  let tags = null;
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(10);
    const got = fs.readSync(fd, header, 0, 10, 0);
    if (got === 10 && header.toString('latin1', 0, 3) === 'ID3') {
      // tamanho "synchsafe" (7 bits úteis por byte)
      const size = ((header[6] & 0x7f) << 21) | ((header[7] & 0x7f) << 14) |
                   ((header[8] & 0x7f) << 7) | (header[9] & 0x7f);
      const footer = (header[5] & 0x10) ? 10 : 0;
      const total = 10 + size + footer;
      const buf = Buffer.alloc(total);
      fs.readSync(fd, buf, 0, total, 0);
      tags = NodeID3.read(buf);
    }
  } finally {
    fs.closeSync(fd);
  }
  if (!tags) tags = NodeID3.read(filePath); // sem ID3v2 no início
  return tags || {};
}

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

// extrai o texto da letra (unsynchronisedLyrics pode ser objeto ou array)
function lyricsText(tags) {
  const ul = tags && tags.unsynchronisedLyrics;
  if (!ul) return '';
  if (Array.isArray(ul)) return (ul[0] && ul[0].text) || '';
  return ul.text || '';
}

// ---------- Tag de sincronização LRCLIB (TXXX:LRCLIB_SYNC) ----------
// Valores: 'synced' | 'local' | 'not_found'
// Ausente = pendente (arquivo nunca passou pelo fluxo de letras).
const LRCLIB_SYNC_DESC = 'LRCLIB_SYNC';

function readLrclibSync(filePath) {
  try {
    const tags = readId3Fast(filePath);
    const txxx = tags.userDefinedText || [];
    const arr = Array.isArray(txxx) ? txxx : [txxx];
    const hit = arr.find((x) => x && x.description === LRCLIB_SYNC_DESC);
    return hit ? hit.value : null;
  } catch { return null; }
}

function writeLrclibSync(filePath, value) {
  try {
    // Lê os frames TXXX existentes para não sobrescrever outros
    const tags = readId3Fast(filePath);
    const existing = Array.isArray(tags.userDefinedText)
      ? tags.userDefinedText
      : (tags.userDefinedText ? [tags.userDefinedText] : []);
    const others = existing.filter((x) => x && x.description !== LRCLIB_SYNC_DESC);
    const merged = [...others, { description: LRCLIB_SYNC_DESC, value }];
    NodeID3.update({ userDefinedText: merged }, filePath);
    return true;
  } catch (err) {
    console.warn('[writeLrclibSync]', err.message);
    return false;
  }
}

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
ipcMain.handle('mp3:cover', (_e, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const tags = readId3Fast(filePath);
    if (!tags.image || !tags.image.imageBuffer) return null;
    const mime = tags.image.mime || 'image/jpeg';
    return `data:${mime};base64,${tags.image.imageBuffer.toString('base64')}`;
  } catch { return null; }
});

// ---------- IPC: ler imagem como data URL (preview) ----------
ipcMain.handle('image:preview', (_e, imagePath) => {
  try {
    const buf = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
});

// ---------- Gemini: motor de limite de requisições (por modelo, FIFO) ----------
// Cada modelo tem seus próprios limites: RPM (requisições/min), TPM (tokens/min)
// e RPD (requisições/dia). Toda chamada passa por aqui; quando algum limite do
// modelo está saturado, as próximas chamadas DAQUELE modelo aguardam em fila,
// preservando a ordem de chegada (que reflete a ordem de término dos downloads).
// Modelos diferentes não bloqueiam uns aos outros.
const MODEL_LIMITS = {
  'gemini-3.1-flash-lite': { rpm: 15, tpm: 250000, rpd: 500 },
  'gemini-2.5-flash': { rpm: 5 }
};
const DEFAULT_LIMITS = { rpm: 5 };
const RPM_WINDOW = 60_000;
const TPM_WINDOW = 60_000;
const RPD_WINDOW = 24 * 60 * 60_000;

function getLimits(model) { return MODEL_LIMITS[model] || DEFAULT_LIMITS; }

// estado de uso por modelo
const geminiState = new Map(); // model -> { reqTimes:[], tokenEvents:[{t,tokens}], dayTimes:[] }
function stateFor(model) {
  let s = geminiState.get(model);
  if (!s) { s = { reqTimes: [], tokenEvents: [], dayTimes: [] }; geminiState.set(model, s); }
  return s;
}

let geminiWaitQueue = [];   // { model, tokens, resolve, onWait }
let geminiPumpTimer = null;

function pruneState(s, now) {
  s.reqTimes = s.reqTimes.filter((t) => now - t < RPM_WINDOW);
  s.tokenEvents = s.tokenEvents.filter((e) => now - e.t < TPM_WINDOW);
  s.dayTimes = s.dayTimes.filter((t) => now - t < RPD_WINDOW);
}

// avalia se uma chamada pode rodar já; senão, retorna a menor espera (ms) e o motivo
function canRunGemini(model, tokens, now) {
  const lim = getLimits(model);
  const s = stateFor(model);
  pruneState(s, now);
  let waitMs = 0, reason = '';
  const consider = (w, why) => { if (w > waitMs) { waitMs = w; reason = why; } };

  if (lim.rpm != null && s.reqTimes.length >= lim.rpm) {
    consider(RPM_WINDOW - (now - s.reqTimes[0]), t('main.reason.rpm'));
  }
  if (lim.rpd != null && s.dayTimes.length >= lim.rpd) {
    consider(RPD_WINDOW - (now - s.dayTimes[0]), t('main.reason.rpd'));
  }
  if (lim.tpm != null) {
    const used = s.tokenEvents.reduce((a, e) => a + e.tokens, 0);
    if (used + tokens > lim.tpm && s.tokenEvents.length) {
      consider(TPM_WINDOW - (now - s.tokenEvents[0].t), t('main.reason.tpm'));
    }
  }
  return waitMs <= 0 ? { ok: true } : { ok: false, waitMs, reason };
}

function pumpGeminiQueue() {
  const now = Date.now();
  const blocked = new Set(); // modelos já bloqueados nesta passada (preserva ordem por modelo)
  let minWait = Infinity;
  let granted = false;

  let i = 0;
  while (i < geminiWaitQueue.length) {
    const item = geminiWaitQueue[i];
    if (blocked.has(item.model)) { i++; continue; }
    const res = canRunGemini(item.model, item.tokens, now);
    if (res.ok) {
      const s = stateFor(item.model);
      s.reqTimes.push(now);
      s.dayTimes.push(now);
      s.tokenEvents.push({ t: now, tokens: item.tokens });
      geminiWaitQueue.splice(i, 1);
      item.resolve();
      granted = true;
    } else {
      blocked.add(item.model);
      if (res.waitMs < minWait) minWait = res.waitMs;
      if (item.onWait) item.onWait(Math.max(1, Math.ceil(res.waitMs / 1000)), res.reason);
      i++;
    }
  }

  if (granted) persistGeminiUsage(); // grava o uso diário (RPD) para sobreviver a reinícios

  if (geminiWaitQueue.length) {
    clearTimeout(geminiPumpTimer);
    const delay = Math.max(50, Math.min(minWait + 50, 30000));
    geminiPumpTimer = setTimeout(pumpGeminiQueue, delay);
  }
}

function acquireGeminiSlot(model, tokens, onWait) {
  return new Promise((resolve) => {
    geminiWaitQueue.push({ model, tokens, resolve, onWait });
    pumpGeminiQueue();
  });
}

// Persistência do uso diário (RPD) no config.json, para sobreviver a reinícios.
// Só os timestamps dentro da janela de 24h importam; o resto é descartado.
function loadGeminiUsage() {
  const cfg = readConfig();
  const usage = cfg.geminiUsage || {};
  const now = Date.now();
  for (const model of Object.keys(usage)) {
    const arr = (Array.isArray(usage[model]) ? usage[model] : [])
      .filter((t) => typeof t === 'number' && now - t < RPD_WINDOW);
    stateFor(model).dayTimes = arr;
  }
}

function persistGeminiUsage() {
  const now = Date.now();
  const usage = {};
  for (const [model, s] of geminiState) {
    const recent = s.dayTimes.filter((t) => now - t < RPD_WINDOW);
    if (recent.length) usage[model] = recent;
  }
  try {
    const cfg = readConfig();
    cfg.geminiUsage = usage;
    writeConfig(cfg);
  } catch { /* best-effort */ }
}

// estimativa grosseira de tokens (entrada ~ chars/4 + orçamento de saída)
function estimateTokens(prompt) {
  return Math.ceil((prompt ? prompt.length : 0) / 4) + 1200;
}

// ---------- Gemini: helper de chamada única (JSON estruturado) ----------
// onWait(segundos, motivo) é chamado caso a requisição precise aguardar o limite.
async function callGemini(cfg, prompt, schema, onWait) {
  const model = cfg.model || 'gemini-2.5-flash';
  await acquireGeminiSlot(model, estimateTokens(prompt), onWait);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: schema
    }
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    let msg = t('main.apiError', { status: resp.status });
    try {
      const j = JSON.parse(errText);
      if (j.error && j.error.message) msg = `Gemini: ${j.error.message}`;
    } catch { /* mantém msg padrão */ }
    throw new Error(msg);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(t('main.apiNoContent'));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(t('main.apiParseFail'));
  }
}

// Schema do JSON final de metadados ID3 (usado pela 2ª chamada e pelo formulário).
const ID3_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    artist: { type: 'string' },
    album: { type: 'string' },
    albumArtist: { type: 'string' },
    year: { type: 'string' },
    genre: { type: 'string' },
    trackNumber: { type: 'string' },
    partOfSet: { type: 'string' },
    composer: { type: 'string' },
    publisher: { type: 'string' },
    comment: { type: 'string' },
    lyrics: { type: 'string' }
  },
  required: ['title', 'artist', 'album']
};

// ---------- IPC: pipeline inteligente (fontes factuais + 2 chamadas ao Gemini) ----------
// 0) FONTES FACTUAIS: MusicBrainz + iTunes a partir de uma semente artista/título.
// 1) ANÁLISE + LACUNAS: com o contexto do YouTube E os fatos já obtidos, o Gemini
//    identifica a faixa e preenche o que falta (sem contradizer fatos de alta confiança).
// 2) CONSISTÊNCIA + NORMALIZAÇÃO: cruza os fatos com a análise e entrega o ID3 final.
// Continua limitado a 2 requisições ao Gemini/música (rate-limited).
ipcMain.handle('gemini:smartMetadata', async (_e, payload) => {
  const cfg = readConfig();
  if (!cfg.apiKey) {
    return { error: t('main.configureKey') };
  }

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
  if (!cfg.apiKey) {
    return { error: t('main.configureKey') };
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

// ====================================================================
// MusicBrainz + Cover Art Archive (fonte factual de metadados e capa)
// ====================================================================
// User-Agent exigido pelo MusicBrainz (app/versão + contato).
const MB_UA = 'Syntune/1.0 ( syntune app; marcoxpg2@gmail.com )';

// Serializa as chamadas ao MusicBrainz garantindo >= 1100ms entre elas (a API
// pede no máx. ~1 req/s). Chamadas concorrentes entram na fila.
let mbChain = Promise.resolve();
let mbLast = 0;
function mbThrottle() {
  const result = mbChain.then(async () => {
    const wait = Math.max(0, 1100 - (Date.now() - mbLast));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    mbLast = Date.now();
  });
  mbChain = result.catch(() => {});
  return result;
}

// remove caracteres especiais do Lucene p/ montar a query com segurança
function luceneSafe(s) {
  return String(s || '').replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function mbFetch(query) {
  const url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=8`;
  await mbThrottle();
  const r = await fetch(url, { headers: { 'User-Agent': MB_UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(t('main.mbUnavailable', { status: r.status }));
  return r.json();
}

// Faz duas buscas e mescla: uma REFINADA (só álbum oficial de estúdio — melhor para
// faixas muito regravadas/ao vivo) e a SIMPLES (melhor para faixas diretas). O
// ranking por qualidade+ano em mbToMatches escolhe o melhor do conjunto unido.
async function mbSearchRecordings(artist, title) {
  const parts = [];
  if (title) parts.push(`recording:"${luceneSafe(title)}"`);
  if (artist) parts.push(`artist:"${luceneSafe(artist)}"`);
  const base = parts.join(' AND ') || luceneSafe(title) || luceneSafe(artist);
  const refined = base + ' AND primarytype:album AND status:official AND -secondarytype:compilation AND -secondarytype:live';

  const results = [];
  for (const q of [refined, base]) {
    try { results.push(await mbFetch(q)); } catch (e) { if (!results.length) throw e; }
  }
  const recs = [];
  const seen = new Set();
  for (const data of results) {
    for (const rec of (Array.isArray(data.recordings) ? data.recordings : [])) {
      if (rec && rec.id && !seen.has(rec.id)) { seen.add(rec.id); recs.push(rec); }
    }
  }
  return { recordings: recs };
}

// de um "recording", escolhe a melhor release: prefere álbum de ESTÚDIO oficial
// (penaliza coletânea/ao vivo/trilha) e, em empate, a data mais antiga.
function bestReleaseOf(rec) {
  const rels = Array.isArray(rec.releases) ? rec.releases : [];
  const scored = rels.map((rel) => {
    const rg = rel['release-group'] || {};
    const primaryType = (rg['primary-type'] || '').toLowerCase();
    const status = (rel.status || '').toLowerCase();
    const secs = (rg['secondary-types'] || []).map((x) => String(x).toLowerCase());
    let s = 0;
    if (primaryType === 'album') s += 3;
    if (status === 'official') s += 2;
    if (secs.includes('compilation')) s -= 3;
    if (secs.includes('live')) s -= 3;
    if (secs.includes('soundtrack') || secs.includes('dj-mix')) s -= 1;
    if (primaryType === 'album' && !secs.length) s += 2; // álbum de estúdio puro
    let trackNumber = '', totalTracks = '';
    const media = Array.isArray(rel.media) ? rel.media[0] : null;
    if (media) {
      totalTracks = media['track-count'] ? String(media['track-count']) : '';
      const tr = Array.isArray(media.track) ? media.track[0] : null;
      if (tr && tr.number) trackNumber = String(tr.number);
    }
    return { rel, s, trackNumber, totalTracks };
  });
  scored.sort((a, b) => b.s - a.s ||
    String(a.rel.date || '9999').localeCompare(String(b.rel.date || '9999')));
  return scored[0] || null;
}

function mbCreditToName(credit) {
  if (!Array.isArray(credit)) return '';
  return credit.map((c) => (c.name || (c.artist && c.artist.name) || '') + (c.joinphrase || '')).join('').trim();
}

function mbToMatches(data) {
  const recs = Array.isArray(data.recordings) ? data.recordings : [];
  const out = [];
  for (const rec of recs.slice(0, 8)) {
    const best = bestReleaseOf(rec);
    const rel = best ? best.rel : null;
    out.push({
      title: rec.title || '',
      artist: mbCreditToName(rec['artist-credit']),
      album: rel ? (rel.title || '') : '',
      year: rel && rel.date ? String(rel.date).slice(0, 4) : '',
      trackNumber: best ? best.trackNumber : '',
      totalTracks: best ? best.totalTracks : '',
      releaseMbid: rel ? rel.id : '',
      score: Number(rec.score) || 0,
      _q: best ? best.s : -99
    });
  }
  // ordena por qualidade da release (estúdio oficial primeiro), depois ano mais
  // antigo (lançamento original) e, por fim, o score textual do MusicBrainz.
  out.sort((a, b) => (b._q - a._q) ||
    (Number(a.year || 9999) - Number(b.year || 9999)) || (b.score - a.score));

  const seen = new Set();
  const deduped = out.filter((m) => {
    const k = `${m.title}|${m.artist}|${m.album}|${m.year}`.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  deduped.forEach((m) => { delete m._q; });
  return deduped.slice(0, 6);
}

// ---------- iTunes Search API (gênero, ano, faixa e capa em alta) ----------
function normName(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
// match aproximado: igual ou um contém o outro (ignora acentos/pontuação)
function fuzzyMatch(a, b) {
  a = normName(a); b = normName(b);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

async function itunesLookup(artist, title) {
  const term = encodeURIComponent(`${artist || ''} ${title || ''}`.trim());
  if (!term) return null;
  const url = `https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=5`;
  const r = await fetch(url, { headers: { 'User-Agent': MB_UA } });
  if (!r.ok) return null;
  const data = await r.json();
  const results = Array.isArray(data.results) ? data.results : [];
  if (!results.length) return null;
  // prefere o que casa artista E título; senão, o primeiro
  const best = results.find((x) => fuzzyMatch(x.artistName, artist) && fuzzyMatch(x.trackName, title))
    || results[0];
  const artwork = (best.artworkUrl100 || best.artworkUrl60 || '').replace(/\/\d+x\d+bb\./, '/600x600bb.');
  return {
    artist: best.artistName || '',
    title: best.trackName || '',
    album: best.collectionName || '',
    year: best.releaseDate ? String(best.releaseDate).slice(0, 4) : '',
    genre: best.primaryGenreName || '',
    trackNumber: best.trackNumber ? String(best.trackNumber) : '',
    totalTracks: best.trackCount ? String(best.trackCount) : '',
    artworkUrl: artwork
  };
}

// Consulta as fontes factuais (MusicBrainz + iTunes) a partir de uma semente
// artista/título. Cada fonte traz um flag de confiança (casou artista e título).
async function gatherFacts(seedArtist, seedTitle) {
  const facts = { sources: [] };
  if (!seedArtist && !seedTitle) return facts;

  try {
    const matches = mbToMatches(await mbSearchRecordings(seedArtist, seedTitle));
    const top = matches[0];
    if (top) {
      top.confident = fuzzyMatch(top.artist, seedArtist) && fuzzyMatch(top.title, seedTitle);
      facts.musicbrainz = top;
      facts.sources.push('MusicBrainz');
    }
  } catch { /* segue sem MB */ }

  try {
    const it = await itunesLookup(seedArtist, seedTitle);
    if (it) {
      it.confident = fuzzyMatch(it.artist, seedArtist) && fuzzyMatch(it.title, seedTitle);
      facts.itunes = it;
      facts.sources.push('iTunes');
    }
  } catch { /* segue sem iTunes */ }

  return facts;
}

// Consolida os fatos: álbum/ano/faixa preferem MusicBrainz; gênero vem do iTunes.
// Marca confiança alta se ao menos uma fonte casou artista+título.
function consolidateFacts(facts) {
  const mb = facts.musicbrainz, it = facts.itunes;
  const mbC = mb && mb.confident, itC = it && it.confident;
  const first = (...vals) => vals.find((v) => v) || '';
  // ano: prefere o MAIS ANTIGO entre as fontes confiáveis (lançamento original,
  // não uma reedição). Cai para qualquer ano disponível se nenhuma for confiável.
  const confYears = [mbC && mb.year, itC && it.year].filter(Boolean).map(Number).filter((y) => y > 1000);
  const year = confYears.length ? String(Math.min(...confYears)) : first(mb && mb.year, it && it.year);
  return {
    artist: first(mbC && mb.artist, itC && it.artist, mb && mb.artist, it && it.artist),
    title: first(mbC && mb.title, itC && it.title, mb && mb.title, it && it.title),
    album: first(mbC && mb.album, itC && it.album, mb && mb.album, it && it.album),
    year,
    trackNumber: first(mbC && mb.trackNumber, itC && it.trackNumber, mb && mb.trackNumber, it && it.trackNumber),
    genre: first(itC && it.genre, it && it.genre),
    releaseMbid: mb ? (mb.releaseMbid || '') : '',
    artworkUrl: it ? (it.artworkUrl || '') : '',
    confident: !!(mbC || itC),
    sources: facts.sources
  };
}

// Capa em alta: tenta o Cover Art Archive (por MBID) e depois o artwork do iTunes.
async function fetchFactualCover(c) {
  if (!c) return null;
  const tryUrl = async (url) => {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': MB_UA }, redirect: 'follow' });
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
      if (!ct.startsWith('image/')) return null;
      return `data:${ct};base64,${buf.toString('base64')}`;
    } catch { return null; }
  };
  if (c.releaseMbid) {
    const caa = await tryUrl(`https://coverartarchive.org/release/${encodeURIComponent(c.releaseMbid)}/front-500`);
    if (caa) return caa;
  }
  if (c.artworkUrl) {
    const it = await tryUrl(c.artworkUrl);
    if (it) return it;
  }
  return null;
}

// extrai "Artista - Título" de um título de vídeo/arquivo (heurística)
function parseArtistTitle(s) {
  const t = (s || '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = t.split(/\s[-–—]\s/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { artist: '', title: t };
}

// monta o bloco de fatos p/ os prompts do Gemini
function factsBlock(c) {
  if (!c || (!c.album && !c.year && !c.genre && !c.trackNumber && !c.artist && !c.title)) {
    return '(nenhum dado factual encontrado nas APIs de música)';
  }
  return [
    `- Fontes consultadas: ${(c.sources || []).join(', ') || '(nenhuma)'}`,
    `- Confiança do match: ${c.confident ? 'ALTA' : 'baixa'}`,
    `- Artista: ${c.artist || '(?)'}`,
    `- Título: ${c.title || '(?)'}`,
    `- Álbum: ${c.album || '(?)'}`,
    `- Ano de lançamento: ${c.year || '(?)'}`,
    `- Número da faixa: ${c.trackNumber || '(?)'}`,
    `- Gênero (iTunes): ${c.genre || '(?)'}`
  ].join('\n');
}

// ---------- LRCLIB: letra sincronizada (LRC) — grátis, sem chave ----------
const LRCLIB_UA = 'Syntune/1.0.0 ( https://github.com/  marcoxpg2@gmail.com )';

async function lrclibGet(artist, title, album, duration) {
  const p = new URLSearchParams({
    artist_name: artist || '', track_name: title || '',
    album_name: album || '', duration: String(Math.round(duration || 0))
  });
  const r = await fetch(`https://lrclib.net/api/get?${p.toString()}`, { headers: { 'User-Agent': LRCLIB_UA } });
  if (!r.ok) return null;
  return r.json();
}
async function lrclibSearch(artist, title) {
  const p = new URLSearchParams({ track_name: title || '', artist_name: artist || '' });
  const r = await fetch(`https://lrclib.net/api/search?${p.toString()}`, { headers: { 'User-Agent': LRCLIB_UA } });
  if (!r.ok) return [];
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}

// detecta tags de tempo [mm:ss.xx] de uma letra sincronizada (LRC)
function isSyncedLyricsText(text) {
  return !!(text && /\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(text));
}

// busca no LRCLIB: tenta /get exato (com duração) e cai para /search
async function fetchLrclib({ artist, title, album, duration } = {}) {
  if (!title && !artist) return { synced: null, plain: null };
  let hit = null;
  if (duration && duration > 0) {
    try { hit = await lrclibGet(artist, title, album, duration); } catch { /* tenta busca */ }
  }
  if (!hit || (!hit.syncedLyrics && !hit.plainLyrics)) {
    try {
      const results = await lrclibSearch(artist, title);
      if (results.length) hit = results.find((x) => x.syncedLyrics) || results[0];
    } catch { /* sem resultado */ }
  }
  if (!hit) return { synced: null, plain: null };
  return { synced: hit.syncedLyrics || null, plain: hit.plainLyrics || null };
}

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

// ---------- Genius: foto do artista (arquivos em userData/artists/) ----------
// artists.json guarda só metadados (url remota, nome do arquivo local, tried);
// os bytes da foto ficam em disco e são servidos via protocolo mp3artist://,
// sem nunca carregar todas as fotos na memória.
const ARTISTS_PATH = () => path.join(app.getPath('userData'), 'artists.json');
const ARTISTS_DIR = () => path.join(app.getPath('userData'), 'artists');
function readArtistsCache() {
  try { return JSON.parse(fs.readFileSync(ARTISTS_PATH(), 'utf-8')) || {}; } catch { return {}; }
}
function writeArtistsCache(c) {
  try { fs.writeFileSync(ARTISTS_PATH(), JSON.stringify(c, null, 2), 'utf-8'); } catch { /* best-effort */ }
}

// nome de arquivo seguro a partir da chave normalizada do artista
function artistFileName(key, mime) {
  const base = key.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'artist';
  return base + (mime === 'image/png' ? '.png' : '.jpg');
}

// grava os bytes da foto em disco e devolve a URL do protocolo
function saveArtistPhoto(key, buf, mime, at) {
  const dir = ARTISTS_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const file = artistFileName(key, mime);
  fs.writeFileSync(path.join(dir, file), buf);
  return { file, url: `mp3artist://${encodeURIComponent(file)}?v=${at}` };
}

// serializa as chamadas ao Genius (~400ms entre elas)
let geniusChain = Promise.resolve();
let geniusLast = 0;
function geniusThrottle() {
  const result = geniusChain.then(async () => {
    const wait = Math.max(0, 400 - (Date.now() - geniusLast));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    geniusLast = Date.now();
  });
  geniusChain = result.catch(() => {});
  return result;
}

// busca a URL da foto do artista no Genius (casa o nome; senão, 1º resultado)
async function geniusArtistImage(name, token) {
  const url = `https://api.genius.com/search?q=${encodeURIComponent(name)}`;
  await geniusThrottle();
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': MB_UA } });
  if (!r.ok) return null;
  const data = await r.json();
  const hits = (data && data.response && data.response.hits) || [];
  const pickImg = (a) => (a && (a.image_url || a.header_image_url)) || null;
  for (const h of hits) {
    const a = h.result && h.result.primary_artist;
    if (a && fuzzyMatch(a.name, name) && pickImg(a)) return pickImg(a);
  }
  const a0 = hits[0] && hits[0].result && hits[0].result.primary_artist;
  return pickImg(a0);
}

// retorna a URL (mp3artist://) da foto do artista; null se não houver token/imagem
ipcMain.handle('artist:image', async (_e, { name } = {}) => {
  const key = normName(name);
  // placeholders de "artista desconhecido" em qualquer idioma da UI não vão ao Genius
  const skip = new Set(['sem artista', 'desconhecido', 'no artist', 'unknown', normName(t('library.noArtist'))]);
  if (!key || skip.has(key)) return { url: null };

  const cache = readArtistsCache();
  const hit = cache[key];

  // migração do formato legado: dataUrl embutida no JSON -> arquivo em disco
  if (hit && hit.dataUrl) {
    try {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(hit.dataUrl);
      if (m) {
        const saved = saveArtistPhoto(key, Buffer.from(m[2], 'base64'), m[1], hit.at || Date.now());
        cache[key] = { name: hit.name || name, url: hit.url || null, file: saved.file, tried: true, at: hit.at || Date.now() };
        writeArtistsCache(cache);
        return { url: saved.url, cached: true };
      }
    } catch { /* migração falhou: rebusca abaixo */ }
    delete hit.dataUrl;
  }

  if (hit && hit.file && fs.existsSync(path.join(ARTISTS_DIR(), hit.file))) {
    return { url: `mp3artist://${encodeURIComponent(hit.file)}?v=${hit.at || 0}`, cached: true };
  }
  if (hit && hit.tried && !hit.url) return { url: null }; // já tentou e não achou

  const token = (readConfig().geniusToken || '').trim();
  if (!token) return { url: null, noToken: true };

  try {
    let imgUrl = hit && hit.url;
    if (!imgUrl) imgUrl = await geniusArtistImage(name, token);
    if (!imgUrl) {
      cache[key] = { name, url: null, tried: true, at: Date.now() };
      writeArtistsCache(cache);
      return { url: null };
    }
    const ir = await fetch(imgUrl, { headers: { 'User-Agent': MB_UA } });
    if (!ir.ok) return { url: null };
    const ct = (ir.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!ct.startsWith('image/')) return { url: null };
    const buf = Buffer.from(await ir.arrayBuffer());
    const at = Date.now();
    const saved = saveArtistPhoto(key, buf, ct, at);
    cache[key] = { name, url: imgUrl, file: saved.file, tried: true, at };
    writeArtistsCache(cache);
    return { url: saved.url };
  } catch (err) {
    return { url: null, error: err.message };
  }
});

const crypto = require('crypto');

// Assinatura exigida pelo protocolo da API do Last.fm: api_sig = MD5 dos
// parâmetros ordenados + secret (https://www.last.fm/api/authspec).
// O MD5 aqui é imposição do serviço — trocar o algoritmo quebra a autenticação.
// (Alerta CodeQL js/weak-cryptographic-algorithm dispensado como won't fix.)
function lastfmSign(params, secret) {
  const keys = Object.keys(params).filter(k => k !== 'format' && k !== 'callback').sort();
  let str = '';
  for (const k of keys) {
    str += k + params[k];
  }
  str += secret;
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

ipcMain.handle('lastfm:authSession', async (_e, { apiKey, secret }) => {
  try {
    const resToken = await fetch(`https://ws.audioscrobbler.com/2.0/?method=auth.getToken&api_key=${encodeURIComponent(apiKey)}&format=json`);
    const dataToken = await resToken.json();
    if (!dataToken.token) return { error: dataToken.message || t('main.lastfmTokenFail') };

    const token = dataToken.token;
    shell.openExternal(`https://www.last.fm/api/auth/?api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`);

    for (let i = 0; i < 45; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const sig = lastfmSign({ api_key: apiKey, method: 'auth.getSession', token }, secret);
      const resSess = await fetch(`https://ws.audioscrobbler.com/2.0/?method=auth.getSession&api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}&api_sig=${encodeURIComponent(sig)}&format=json`);
      const dataSess = await resSess.json();
      if (dataSess.session) {
        return { sessionKey: dataSess.session.key, username: dataSess.session.name };
      }
      if (dataSess.error && dataSess.error !== 14) {
        return { error: dataSess.message || t('main.lastfmAuthError') };
      }
    }
    return { error: t('main.lastfmAuthTimeout') };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('lastfm:scrobble', async (_e, { artist, title, timestamp }) => {
  const cfg = readConfig();
  if (!cfg.lastfmScrobbleEnabled || !cfg.lastfmSessionKey || !cfg.lastfmApiKey || !cfg.lastfmSecret) return { success: false };
  try {
    const params = {
      method: 'track.scrobble',
      api_key: cfg.lastfmApiKey.trim(),
      sk: cfg.lastfmSessionKey.trim(),
      'artist[0]': artist,
      'track[0]': title,
      'timestamp[0]': String(timestamp)
    };
    const sig = lastfmSign(params, cfg.lastfmSecret.trim());
    params.api_sig = sig;
    params.format = 'json';

    const form = new URLSearchParams();
    for (const k in params) form.append(k, params[k]);

    const res = await fetch('https://ws.audioscrobbler.com/2.0/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    const data = await res.json();
    return { success: !data.error };
  } catch {
    return { success: false };
  }
});

ipcMain.handle('lastfm:getPlaycount', async (_e, { artist, title } = {}) => {
  if (!artist || !title) return null;
  const cfg = readConfig();
  const key = (cfg.lastfmApiKey || '').trim();
  if (!key) return null;

  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=track.getInfo&api_key=${encodeURIComponent(key)}&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(title)}&format=json&autocorrect=1`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Syntune/1.0' } });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.track) {
      const playcount = data.track.playcount || '0';
      const listeners = data.track.listeners || '0';
      const tags = (data.track.toptags && Array.isArray(data.track.toptags.tag))
        ? data.track.toptags.tag.slice(0, 5).map(t => t.name)
        : [];
      return { playcount, listeners, tags };
    }
  } catch (err) {
    console.error('Erro Last.fm API:', err.message);
  }
  return null;
});

ipcMain.handle('lastfm:getArtistInfo', async (_e, { artist } = {}) => {
  if (!artist) return null;
  const cfg = readConfig();
  const key = (cfg.lastfmApiKey || '').trim();
  if (!key) return null;

  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getInfo&api_key=${encodeURIComponent(key)}&artist=${encodeURIComponent(artist)}&format=json&autocorrect=1&lang=${encodeURIComponent(i18n.getLanguage().split('-')[0])}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Syntune/1.0' } });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.artist) {
      const bio = data.artist.bio && data.artist.bio.summary ? data.artist.bio.summary : '';
      const playcount = data.artist.stats ? data.artist.stats.playcount : '0';
      const listeners = data.artist.stats ? data.artist.stats.listeners : '0';
      const tags = (data.artist.tags && Array.isArray(data.artist.tags.tag))
        ? data.artist.tags.tag.slice(0, 5).map(t => t.name)
        : [];
      return { bio, playcount, listeners, tags };
    }
  } catch (err) {
    console.error('Erro Last.fm Artist API:', err.message);
  }
  return null;
});

async function solveLrclibChallenge() {
  try {
    const res = await fetch('https://lrclib.net/api/request-challenge', { method: 'POST' });
    const data = await res.json();
    const prefix = data.prefix;
    const target = data.target.toLowerCase();
    let nonce = 0;
    while (nonce < 20000000) {
      const hash = crypto.createHash('sha256').update(prefix + String(nonce)).digest('hex');
      if (hash <= target) {
        return prefix + ':' + nonce;
      }
      nonce++;
    }
  } catch (err) {
    console.error('LRCLIB Challenge Error:', err);
  }
  return null;
}

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

// ---------- Detecção de dispositivos removíveis (polling via PowerShell/CIM) ----------
// Junta Win32_DiskDrive (USB/removível) → partição → disco lógico, retornando, por
// volume: serial de hardware do disco, serial do volume (fallback), letra, rótulo e tamanhos.
const PS_DRIVE_QUERY = `
$ErrorActionPreference='SilentlyContinue'
$out=@()
$lds = Get-WmiObject Win32_LogicalDisk -Filter "DriveType=2"
if (-not $lds) { Write-Output '[]'; exit }
$disks = @{}
Get-WmiObject Win32_DiskDrive -Filter "InterfaceType='USB'" | ForEach-Object {
  $d=$_
  $d.GetRelated('Win32_DiskPartition') | ForEach-Object {
    $p=$_
    $p.GetRelated('Win32_LogicalDisk') | ForEach-Object {
      $disks[$_.DeviceID] = @{ serial=($d.SerialNumber -as [string]); model=$d.Model }
    }
  }
}
$lds | ForEach-Object {
  $ld=$_
  $disk=$disks[$ld.DeviceID]
  $out += [pscustomobject]@{
    serial=if($disk){$disk.serial}else{''};
    model=if($disk){$disk.model}else{'Removivel'};
    drive=$ld.DeviceID; label=$ld.VolumeName;
    volSerial=$ld.VolumeSerialNumber; size=$ld.Size; free=$ld.FreeSpace
  }
}
if ($out.Count -eq 0) { Write-Output '[]' } else { $out | ConvertTo-Json -Compress }
`;

function cleanSerial(s) {
  return (s == null ? '' : String(s)).replace(/\s+/g, '').trim();
}

// monta o serial efetivo: hardware (estável) com fallback para o serial do volume
function normalizeDrive(d) {
  if (!d || !d.drive) return null;
  const hw = cleanSerial(d.serial);
  const vol = cleanSerial(d.volSerial);
  let serial, usedVolumeFallback = false;
  if (hw) serial = 'HW:' + hw;
  else if (vol) { serial = 'VOL:' + vol; usedVolumeFallback = true; }
  else return null;
  return {
    serial, usedVolumeFallback,
    drive: String(d.drive),                 // ex.: "E:"
    label: d.label || '',
    model: d.model || '',
    size: Number(d.size) || 0,
    free: Number(d.free) || 0
  };
}

function queryRemovableDrives() {
  return new Promise((resolve) => {
    const encoded = Buffer.from(PS_DRIVE_QUERY, 'utf16le').toString('base64');
    let ps;
    try {
      ps = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true });
    } catch { return resolve([]); }

    let stdout = '';
    let settled = false;

    // Timeout de segurança: mata o PowerShell se demorar mais de 15 s
    // (o Windows pode demorar ao inicializar drivers USB recém plugados)
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ps.kill(); } catch { /* já terminou */ }
      consecutiveTimeouts++;
      if (consecutiveTimeouts <= 2) {
        console.warn('[queryRemovableDrives] timeout — PowerShell demorou demais, ignorando.');
      }
      resolve([]);
    }, 15000);

    ps.stdout.on('data', (d) => { stdout += d; });
    ps.stderr.on('data', () => { /* ignora ruído */ });
    ps.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); resolve([]); } });
    ps.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      consecutiveTimeouts = 0; // sucesso — zera o contador
      const txt = stdout.trim();
      if (!txt) return resolve([]);
      let parsed;
      try { parsed = JSON.parse(txt); } catch { return resolve([]); }
      if (!parsed) return resolve([]);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      resolve(arr.map(normalizeDrive).filter(Boolean));
    });
  });
}

let consecutiveTimeouts = 0; // conta timeouts seguidos para back-off

const connectedDevices = new Map(); // serial -> { drive, label, model, size, free, lastSeen }
let devicePollTimer = null;
let devicePolling = false;

function startDevicePolling() {
  if (process.platform !== 'win32') return; // detecção implementada só p/ Windows
  const tick = async () => {
    if (devicePolling) return; // evita sobreposição de execuções
    devicePolling = true;
    try {
      const drives = await queryRemovableDrives();
      reconcileDevices(drives);
    } catch { /* segue na próxima passada */ } finally {
      devicePolling = false;
    }
  };
  tick();
  // Intervalo de 8 s: dá tempo ao Windows finalizar a inicialização de drivers USB
  // antes da próxima consulta CIM, evitando empilhamento de timeouts
  devicePollTimer = setInterval(tick, 8000);
}

function reconcileDevices(drives) {
  const now = Date.now();
  const seen = new Map();
  for (const d of drives) {
    if (!seen.has(d.serial)) seen.set(d.serial, d); // dedupe por serial (vários volumes/disco)
  }
  // conexões novas
  for (const [serial, d] of seen) {
    const wasConnected = connectedDevices.has(serial);
    connectedDevices.set(serial, { ...d, lastSeen: now });
    if (!wasConnected) onDeviceAttached(d);
  }
  // desconexões
  for (const serial of [...connectedDevices.keys()]) {
    if (!seen.has(serial)) {
      connectedDevices.delete(serial);
      send('device:detached', { serial });
    }
  }
}

function onDeviceAttached(d) {
  const cfg = readConfig();
  cfg.devices = cfg.devices || {};
  const entry = cfg.devices[d.serial] || {
    serial: d.serial, nickname: '', syncEnabled: false, ignored: false, configured: false
  };
  entry.lastLabel = d.label;
  entry.lastSeen = Date.now();
  entry.usedVolumeFallback = d.usedVolumeFallback;
  cfg.devices[d.serial] = entry;
  writeConfig(cfg);

  send('device:attached', {
    serial: d.serial, drive: d.drive, label: d.label, model: d.model,
    size: d.size, free: d.free,
    nickname: entry.nickname, syncEnabled: !!entry.syncEnabled,
    ignored: !!entry.ignored, configured: !!entry.configured,
    usedVolumeFallback: !!entry.usedVolumeFallback
  });
}

// ---------- Persistência do estado de sincronização (sync.json em userData) ----------
const SYNC_PATH = () => path.join(app.getPath('userData'), 'sync.json');
function readSyncState() {
  try { return JSON.parse(fs.readFileSync(SYNC_PATH(), 'utf-8')) || {}; } catch { return {}; }
}
function writeSyncState(state) {
  try { fs.writeFileSync(SYNC_PATH(), JSON.stringify(state, null, 2), 'utf-8'); } catch { /* best-effort */ }
}

// chave de identidade da faixa: nome + artista + ano (case/espaço-insensível)
function normPart(s) { return (s == null ? '' : String(s)).toLowerCase().trim().replace(/\s+/g, ' '); }
function syncKey(title, artist, year) {
  return `${normPart(title)}|${normPart(artist)}|${(year == null ? '' : String(year)).trim()}`;
}

function deviceMusicDir(serial) {
  const d = connectedDevices.get(serial);
  if (!d) return null;
  const root = d.drive.endsWith(':') ? d.drive + path.sep : d.drive;
  return path.join(root, 'music');
}

// ---------- Thread de sincronização (worker) ----------
// A varredura/cópia de arquivos roda num worker thread para não travar o
// processo principal (UI/IPC/polling). O worker reporta progresso e resultado
// por mensagens correlacionadas por id.
let syncWorker = null;
let syncTaskSeq = 0;
const syncTasks = new Map(); // id -> { resolve, onProgress }

function ensureSyncWorker() {
  if (syncWorker) return syncWorker;
  syncWorker = new Worker(path.join(__dirname, 'sync-worker.js'));
  syncWorker.on('message', (m) => {
    const t = syncTasks.get(m.id);
    if (!t) return;
    if (m.type === 'progress') {
      if (t.onProgress) t.onProgress(m.payload || {});
    } else {
      syncTasks.delete(m.id);
      t.resolve(m.type === 'error' ? { error: m.error } : m.result);
    }
  });
  // falha geral do worker: resolve tudo que estava pendente e recria na próxima
  syncWorker.on('error', (err) => {
    for (const t of syncTasks.values()) t.resolve({ error: err.message });
    syncTasks.clear();
    syncWorker = null;
  });
  syncWorker.on('exit', () => { syncWorker = null; });
  return syncWorker;
}

function runSyncTask(type, params, onProgress) {
  return new Promise((resolve) => {
    const w = ensureSyncWorker();
    const id = ++syncTaskSeq;
    syncTasks.set(id, { resolve, onProgress });
    w.postMessage({ id, type, params });
  });
}

// lê o escopo de sincronização configurado p/ o dispositivo
function deviceScope(serial) {
  const cfg = readConfig();
  const e = (cfg.devices || {})[serial];
  if (e && e.syncScope && e.syncScope.mode === 'artists') {
    return { mode: 'artists', artists: Array.isArray(e.syncScope.artists) ? e.syncScope.artists : [] };
  }
  return { mode: 'all' };
}

// monta os parâmetros (caminhos) que o worker precisa para um dispositivo
function deviceTaskParams(serial) {
  const d = connectedDevices.get(serial);
  if (!d) return null;
  return {
    serial,
    musicDir: deviceMusicDir(serial),
    libraryDir: getLibraryDir(),
    syncPath: SYNC_PATH(),
    free: d.free || 0,
    scope: deviceScope(serial)
  };
}

// ---------- Varredura (assíncrona, no worker) ----------
async function scanDevice(serial, onProgress) {
  const params = deviceTaskParams(serial);
  if (!params) return { error: t('main.deviceNotConnected') };
  return runSyncTask('scan', params, onProgress);
}

// ---------- Sincronização (assíncrona, no worker), serializada por dispositivo ----------
const syncing = new Map(); // serial -> { rerun }
async function syncDevice(serial, onProgress) {
  const params = deviceTaskParams(serial);
  if (!params) return { error: t('main.deviceNotConnected') };

  // evita sincronizações concorrentes p/ o mesmo dispositivo; reexecuta se algo
  // mudou (ex.: nova música) enquanto a anterior rodava.
  if (syncing.has(serial)) { syncing.get(serial).rerun = true; return { queued: true }; }
  const guard = { rerun: false };
  syncing.set(serial, guard);
  let result;
  try {
    do {
      guard.rerun = false;
      const p = deviceTaskParams(serial);
      if (!p) { result = { error: t('main.deviceDisconnected') }; break; }
      result = await runSyncTask('sync', p, onProgress);
    } while (guard.rerun && connectedDevices.has(serial));
  } finally {
    syncing.delete(serial);
  }
  return result;
}

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

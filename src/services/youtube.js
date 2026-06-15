/**
 * @module  services/youtube
 * @badge   🟦 SERVICE · NETWORK · BINARY-DOWNLOAD · STATEFUL(promise-dedupe) · FS
 * @role    Provisiona binários yt-dlp/ffmpeg sob demanda (1x, em userData) e coleta o contexto rico de uma página do YouTube p/ o pipeline de metadados.
 * @inputs  url do YouTube, callback onStatus, instância ytDlp
 * @outputs instância YTDlpWrap, caminho do ffmpeg, objeto de contexto do vídeo, sanitizeName/isYouTubeUrl
 * @deps    fs, path, electron(app), yt-dlp-wrap, zlib, stream, ../../i18n
 * @notes   Download de binário deduplicado por promise compartilhada (jobs concorrentes). O handler youtube:download (orquestração) fica em main.js.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const YTDlpWrap = require('yt-dlp-wrap').default;
const { createGunzip } = require('zlib');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const i18n = require('../../i18n');
const t = i18n.t;

// ---------- yt-dlp: binário (download único na 1ª vez) ----------
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

module.exports = { YTDLP_PATH, FFMPEG_PATH, ensureYtDlp, ensureFfmpeg, sanitizeName, isYouTubeUrl, fetchYouTubeContext };

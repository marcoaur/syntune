/**
 * @module  media/id3
 * @badge   🟩 MEDIA · FS · STATELESS · NO-NET
 * @role    Fast ID3v2 tag read/write for MP3 (header-only fast path), lyrics + LRCLIB_SYNC TXXX tag, cover/image → data URL.
 * @inputs  filePath / imagePath (string), tag objects
 * @outputs tag objects, data URLs (string|null), booleans
 * @deps    fs, path, node-id3
 * @notes   No external state; safe to require anywhere in main process.
 */
const fs = require('fs');
const path = require('path');
const NodeID3 = require('node-id3');

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

// capa embutida do MP3 como data URL (lazy, sob demanda)
function coverDataUrl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const tags = readId3Fast(filePath);
    if (!tags.image || !tags.image.imageBuffer) return null;
    const mime = tags.image.mime || 'image/jpeg';
    return `data:${mime};base64,${tags.image.imageBuffer.toString('base64')}`;
  } catch { return null; }
}

// imagem do disco como data URL (preview)
function imagePreviewDataUrl(imagePath) {
  try {
    const buf = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

module.exports = { readId3Fast, lyricsText, readLrclibSync, writeLrclibSync, coverDataUrl, imagePreviewDataUrl, LRCLIB_SYNC_DESC };

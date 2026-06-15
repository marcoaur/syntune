/**
 * @module  sync-engine
 * @badge   🟨 DEVICE · FS · ASYNC-IO · PARALLEL · DELTA-SYNC · NO-ELECTRON
 * @role    Motor puro de varredura/cópia/diff PC↔dispositivo: I/O assíncrono, paralelismo controlado, cache por stat (mtime/size), índice reverso e delta sync.
 * @inputs  caminhos PC/dispositivo, escopo, callbacks de progresso
 * @outputs estatísticas de scan, resultado de sync, eventos de progresso
 * @deps    fs, path (puro Node — roda dentro do worker thread)
 * @notes   Sem dependências do Electron — testável fora do app. Serializado por dispositivo no caller.
 */
// ====================================================================
// Motor de sincronização (puro Node, sem dependências do Electron).
// Otimizado com I/O Assíncrono, Paralelismo Controlado, Cache baseado
// em stat (mtime/size), Índice reverso no dispositivo e Delta Sync.
// ====================================================================
const fs = require('fs');
const fsP = fs.promises;
const path = require('path');
const NodeID3 = require('node-id3');

// Leitura rápida de ID3v2 Assíncrona
async function readId3FastAsync(filePath) {
  let tags = null;
  let fd;
  try {
    fd = await fsP.open(filePath, 'r');
    const header = Buffer.alloc(10);
    const { bytesRead } = await fd.read(header, 0, 10, 0);
    if (bytesRead === 10 && header.toString('latin1', 0, 3) === 'ID3') {
      const size = ((header[6] & 0x7f) << 21) | ((header[7] & 0x7f) << 14) |
                   ((header[8] & 0x7f) << 7) | (header[9] & 0x7f);
      const footer = (header[5] & 0x10) ? 10 : 0;
      const total = 10 + size + footer;
      const buf = Buffer.alloc(total);
      await fd.read(buf, 0, total, 0);
      tags = NodeID3.read(buf);
    }
  } catch (err) {
  } finally {
    if (fd) await fd.close();
  }
  if (!tags) {
    try {
      const buf = await fsP.readFile(filePath);
      tags = NodeID3.read(buf);
    } catch {}
  }
  return tags || {};
}

function sanitizeName(name) {
  return (name || 'audio').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 120) || 'audio';
}

// Assíncrono único de caminho
async function uniquePathAsync(destPath) {
  let exists = true;
  try { await fsP.stat(destPath); } catch { exists = false; }
  if (!exists) return destPath;

  const dir = path.dirname(destPath);
  const ext = path.extname(destPath);
  const base = path.basename(destPath, ext);
  let i = 2;
  let candidate;
  do {
    candidate = path.join(dir, `${base} (${i}).${ext.replace(/^\./, '')}`);
    try { await fsP.stat(candidate); exists = true; i++; } catch { exists = false; }
  } while (exists);
  return candidate;
}

function normPart(s) { return (s == null ? '' : String(s)).toLowerCase().trim().replace(/\s+/g, ' '); }
function syncKey(title, artist, year) {
  return `${normPart(title)}|${normPart(artist)}|${(year == null ? '' : String(year)).trim()}`;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
function tagText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(tagText).join('␟');
  if (typeof v === 'object') return v.text != null ? String(v.text) : '';
  return String(v);
}
function metaHash(tags) {
  const t = tags || {};
  const img = t.image && t.image.imageBuffer ? t.image.imageBuffer.length : 0;
  const imgMime = (t.image && t.image.mime) || '';
  const parts = [
    t.title, t.artist, t.album, t.performerInfo, t.year, t.genre,
    t.trackNumber, t.partOfSet, t.composer, t.publisher,
    tagText(t.comment), tagText(t.unsynchronisedLyrics), imgMime, img
  ].map((x) => (x == null ? '' : String(x)));
  return fnv1a(parts.join('␞'));
}

function normFolder(s) { return (s == null ? '' : String(s)).toLowerCase().replace(/\s+/g, ''); }
function capitalizeArtist(name) {
  const n = (name || '').trim();
  if (!n) return 'Desconhecido';
  return n.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}

async function resolveArtistDirAsync(musicDir, artist) {
  const target = normFolder(artist || 'Desconhecido');
  let dirs = [];
  try {
    const entries = await fsP.readdir(musicDir, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { }
  const match = dirs.find((name) => normFolder(name) === target);
  if (match) return path.join(musicDir, match);
  return path.join(musicDir, sanitizeName(capitalizeArtist(artist)));
}

function readSyncState(syncPath) {
  try { return JSON.parse(fs.readFileSync(syncPath, 'utf-8')) || {}; } catch { return {}; }
}
function writeSyncState(syncPath, state) {
  try { fs.writeFileSync(syncPath, JSON.stringify(state, null, 2), 'utf-8'); } catch { }
}

// Concurrency utility
async function runWithLimit(tasks, limit) {
  const results = [];
  const executing = [];
  for (const task of tasks) {
    const p = Promise.resolve().then(() => task());
    results.push(p);
    if (limit <= tasks.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

// Recurse directory
async function getFilesRec(dir, prefix = '') {
  let entries;
  try { entries = await fsP.readdir(dir, { withFileTypes: true }); } catch { return []; }
  let files = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...await getFilesRec(full, rel));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.mp3')) files.push({ rel, full, name: e.name });
  }
  return files;
}

// List PC Library (with mtime/size Cache)
async function listLibrarySongs(libraryDir, state) {
  if (!state.pcCache) state.pcCache = {};
  const cache = state.pcCache;
  const files = await getFilesRec(libraryDir);
  
  const songs = [];
  await runWithLimit(files.map(f => async () => {
    let stats;
    try { stats = await fsP.stat(f.full); } catch { return; }
    const mtime = Math.floor(stats.mtimeMs);
    const size = stats.size;
    
    let cached = cache[f.full];
    if (cached && cached.size === size && cached.mtime === mtime) {
      songs.push({
        filePath: f.full, fileName: f.name,
        title: cached.title || '', artist: cached.artist || '', year: cached.year || '',
        hash: cached.hash
      });
      return;
    }
    
    let tags = await readId3FastAsync(f.full);
    const hash = metaHash(tags);
    const entry = { mtime, size, title: tags.title || '', artist: tags.artist || '', year: tags.year || '', hash };
    cache[f.full] = entry;
    songs.push({
      filePath: f.full, fileName: f.name, title: entry.title, artist: entry.artist, year: entry.year, hash
    });
  }), 10);
  
  const currentPaths = new Set(files.map(f => f.full));
  for (const k of Object.keys(cache)) {
    if (!currentPaths.has(k)) delete cache[k];
  }
  return songs;
}

// List Device Tracks (with device-side Index)
async function listDeviceTracks(musicDir) {
  const indexPath = path.join(musicDir, '.syntune-index.json');
  let index = {};
  try { index = JSON.parse(await fsP.readFile(indexPath, 'utf-8')); } catch {}
  
  const files = await getFilesRec(musicDir);
  const tracks = [];
  
  await runWithLimit(files.map(f => async () => {
    let stats;
    try { stats = await fsP.stat(f.full); } catch { return; }
    const mtime = Math.floor(stats.mtimeMs);
    const size = stats.size;
    
    let cached = index[f.rel];
    if (cached && cached.size === size && cached.mtime === mtime) {
      tracks.push({
        filePath: f.full, relPath: f.rel, fileName: f.name,
        title: cached.title || '', artist: cached.artist || '', year: cached.year || '',
        coverDataUrl: cached.coverDataUrl, hash: cached.hash
      });
      return;
    }
    
    let tags = await readId3FastAsync(f.full);
    let coverDataUrl = null;
    if (tags.image && tags.image.imageBuffer) {
      coverDataUrl = `data:${tags.image.mime || 'image/jpeg'};base64,${tags.image.imageBuffer.toString('base64')}`;
    }
    const hash = metaHash(tags);
    const entry = { mtime, size, title: tags.title || '', artist: tags.artist || '', year: tags.year || '', hash, coverDataUrl };
    index[f.rel] = entry;
    tracks.push({
      filePath: f.full, relPath: f.rel, fileName: f.name, title: entry.title, artist: entry.artist, year: entry.year, hash, coverDataUrl
    });
  }), 5);
  
  const currentRels = new Set(files.map(f => f.rel));
  for (const k of Object.keys(index)) {
    if (!currentRels.has(k)) delete index[k];
  }
  
  try { await fsP.writeFile(indexPath, JSON.stringify(index), 'utf-8'); } catch {}
  return tracks;
}

function inScope(song, scope) {
  if (!scope || scope.mode !== 'artists') return true;
  if (!scope._set) scope._set = new Set((scope.artists || []).map((a) => normPart(a)));
  return scope._set.has(normPart(song.artist || ''));
}

function devEntry(state, serial) {
  let e = state[serial];
  if (!e || typeof e !== 'object') e = {};
  if (!e.keys && !e.bySrc) e = { keys: e, bySrc: {} };
  if (!e.keys || typeof e.keys !== 'object') e.keys = {};
  if (!e.bySrc || typeof e.bySrc !== 'object') e.bySrc = {};
  state[serial] = e;
  return e;
}

async function scan({ serial, musicDir, libraryDir, syncPath, scope }, onProgress) {
  try { await fsP.mkdir(musicDir, { recursive: true }); } catch { }

  if (onProgress) onProgress({ msg: 'Varrendo músicas do dispositivo…' });
  const deviceTracks = await listDeviceTracks(musicDir);
  const deviceKeys = new Set(deviceTracks.map((t) => syncKey(t.title, t.artist, t.year)));
  const relByKey = new Map();
  for (const t of deviceTracks) relByKey.set(syncKey(t.title, t.artist, t.year), t.relPath);
  
  const deviceHashByKey = new Map();
  for (const t of deviceTracks) deviceHashByKey.set(syncKey(t.title, t.artist, t.year), t.hash);
  
  const state = readSyncState(syncPath);
  const lib = await listLibrarySongs(libraryDir, state);
  const libKeys = new Set(lib.map((s) => syncKey(s.title, s.artist, s.year)));

  const pending = lib.filter((s) => inScope(s, scope) && deviceHashByKey.get(syncKey(s.title, s.artist, s.year)) !== s.hash);
  const deviceOnly = deviceTracks.filter((t) => !libKeys.has(syncKey(t.title, t.artist, t.year)));

  let pendingBytes = 0;
  await Promise.all(pending.map(async (s) => {
    try { const st = await fsP.stat(s.filePath); pendingBytes += st.size; } catch {}
  }));

  const e = devEntry(state, serial);
  const keys = {};
  for (const t of deviceTracks) {
    keys[syncKey(t.title, t.artist, t.year)] = {
      title: t.title, artist: t.artist, year: t.year, fileName: t.fileName, hash: t.hash, syncedAt: Date.now()
    };
  }
  e.keys = keys;
  const relSet = new Set([...relByKey.values()]);
  for (const src of Object.keys(e.bySrc)) {
    if (!relSet.has(e.bySrc[src].deviceRel)) delete e.bySrc[src];
  }
  for (const s of lib) {
    const key = syncKey(s.title, s.artist, s.year);
    if (relByKey.has(key) && !e.bySrc[s.filePath]) {
      e.bySrc[s.filePath] = { key, deviceRel: relByKey.get(key), syncedAt: Date.now() };
    }
  }
  writeSyncState(syncPath, state);

  return { serial, syncedKeys: Object.keys(keys), pendingCount: pending.length, pendingBytes, deviceOnly: deviceOnly.map((t) => ({ ...t, deviceOnly: true, serial })) };
}

async function sync({ serial, musicDir, libraryDir, syncPath, free, scope }, onProgress) {
  try { await fsP.mkdir(musicDir, { recursive: true }); } catch { }

  const deviceTracks = await listDeviceTracks(musicDir);
  const deviceKeys = new Set(deviceTracks.map((t) => syncKey(t.title, t.artist, t.year)));
  const relByKey = new Map();
  for (const t of deviceTracks) relByKey.set(syncKey(t.title, t.artist, t.year), t.relPath);
  
  const deviceHashByKey = new Map();
  for (const t of deviceTracks) deviceHashByKey.set(syncKey(t.title, t.artist, t.year), t.hash);
  
  const state = readSyncState(syncPath);
  const lib = await listLibrarySongs(libraryDir, state);

  const e = devEntry(state, serial);
  const keys = {};
  for (const t of deviceTracks) {
    keys[syncKey(t.title, t.artist, t.year)] = { title: t.title, artist: t.artist, year: t.year, fileName: t.fileName, hash: t.hash, syncedAt: Date.now() };
  }
  e.keys = keys;

  let replaced = 0;
  const removeFromDevice = async (key, rel) => {
    if (rel) {
      const oldAbs = path.join(musicDir, rel);
      try { await fsP.unlink(oldAbs); replaced++; } catch {}
    }
    delete e.keys[key];
    deviceKeys.delete(key);
    relByKey.delete(key);
    deviceHashByKey.delete(key);
  };

  const deltaUpdates = []; 
  for (const s of lib) {
    if (!inScope(s, scope)) continue;
    const key = syncKey(s.title, s.artist, s.year);
    const prev = e.bySrc[s.filePath];
    
    if (prev && prev.key !== key) {
      await removeFromDevice(prev.key, prev.deviceRel);
      delete e.bySrc[s.filePath];
    } else if (deviceKeys.has(key) && deviceHashByKey.get(key) !== s.hash) {
      const deviceRel = relByKey.get(key);
      if (deviceRel) {
        deltaUpdates.push({ song: s, deviceRel });
      } else {
        await removeFromDevice(key, deviceRel);
        delete e.bySrc[s.filePath];
      }
    }
  }

  const pending = lib.filter((s) => inScope(s, scope) && !deviceKeys.has(syncKey(s.title, s.artist, s.year)));
  let freeNow = Number(free) || 0;
  const totalTasks = pending.length + deltaUpdates.length;
  let done = 0, copied = 0, failed = 0, deltaCount = 0;

  await runWithLimit(deltaUpdates.map(update => async () => {
    done++;
    const s = update.song;
    if (onProgress) {
      const label = (s.artist && s.title) ? `${s.artist} - ${s.title}` : (s.title || s.fileName);
      onProgress({ msg: `Atualizando Metadados ${done}/${totalTasks}…`, percent: Math.round((done / Math.max(1, totalTasks)) * 100), current: label, done, total: totalTasks });
    }
    try {
      const destAbs = path.join(musicDir, update.deviceRel);
      const tags = await fsP.readFile(s.filePath).then(b => NodeID3.read(b));
      NodeID3.update(tags, destAbs);
      deltaCount++;
      const key = syncKey(s.title, s.artist, s.year);
      e.keys[key] = { title: s.title, artist: s.artist, year: s.year, fileName: path.basename(destAbs), hash: s.hash, syncedAt: Date.now() };
      e.bySrc[s.filePath] = { key, deviceRel: update.deviceRel, hash: s.hash, syncedAt: Date.now() };
      deviceHashByKey.set(key, s.hash);
    } catch { failed++; }
  }), 3);

  await runWithLimit(pending.map(s => async () => {
    done++;
    if (onProgress) {
      const label = (s.artist && s.title) ? `${s.artist} - ${s.title}` : (s.title || s.fileName);
      onProgress({ msg: `Copiando ${done}/${totalTasks}…`, percent: Math.round((done / Math.max(1, totalTasks)) * 100), current: label, done, total: totalTasks });
    }
    let size = 0;
    try { size = (await fsP.stat(s.filePath)).size; } catch { failed++; return; }
    if (freeNow && size && size > freeNow) { failed++; return; } 

    const artistDir = await resolveArtistDirAsync(musicDir, s.artist);
    try { await fsP.mkdir(artistDir, { recursive: true }); } catch { }
    const destName = sanitizeName(s.fileName.replace(/\.mp3$/i, '')) + '.mp3';
    const dest = await uniquePathAsync(path.join(artistDir, destName));
    const key = syncKey(s.title, s.artist, s.year);
    try {
      await fsP.copyFile(s.filePath, dest);
      copied++;
      if (freeNow) freeNow -= size; 
      const deviceRel = path.relative(musicDir, dest).replace(/\\/g, '/');
      e.keys[key] = { title: s.title, artist: s.artist, year: s.year, fileName: path.basename(dest), hash: s.hash, syncedAt: Date.now() };
      e.bySrc[s.filePath] = { key, deviceRel, hash: s.hash, syncedAt: Date.now() };
      deviceKeys.add(key);
      relByKey.set(key, deviceRel);
      deviceHashByKey.set(key, s.hash);
    } catch { failed++; }
  }), 3);

  try {
     const indexPath = path.join(musicDir, '.syntune-index.json');
     await fsP.unlink(indexPath).catch(()=>{}); 
     await listDeviceTracks(musicDir); 
  } catch {}

  for (const s of lib) {
    if (!inScope(s, scope)) continue;
    const key = syncKey(s.title, s.artist, s.year);
    if (!e.bySrc[s.filePath] && relByKey.has(key)) {
      e.bySrc[s.filePath] = { key, deviceRel: relByKey.get(key), hash: deviceHashByKey.get(key), syncedAt: Date.now() };
    }
  }

  writeSyncState(syncPath, state);
  return { serial, copied, deltaCount, failed, replaced, total: totalTasks, syncedKeys: Object.keys(e.keys) };
}

async function syncPlaylist({ serial, musicDir, libraryDir, syncPath, tracks, name }, onProgress) {
  try { await fsP.mkdir(musicDir, { recursive: true }); } catch { }

  const deviceTracks = await listDeviceTracks(musicDir);
  const relByKey = new Map();
  for (const t of deviceTracks) relByKey.set(syncKey(t.title, t.artist, t.year), t.relPath);

  const state = readSyncState(syncPath);
  const e = devEntry(state, serial);
  e.keys = {};
  for (const t of deviceTracks) {
    e.keys[syncKey(t.title, t.artist, t.year)] = { title: t.title, artist: t.artist, year: t.year, fileName: t.fileName, syncedAt: Date.now() };
  }

  const list = Array.isArray(tracks) ? tracks : [];
  const total = list.length;
  let done = 0, copied = 0, failed = 0;
  const entries = [];

  await runWithLimit(list.map(pcPath => async () => {
    done++;
    let tags = {};
    try { tags = await fsP.readFile(pcPath).then(b => NodeID3.read(b)); } catch { failed++; return; }
    const key = syncKey(tags.title || '', tags.artist || '', tags.year || '');
    const label = `${tags.artist || ''} - ${tags.title || ''}`.replace(/^ - | - $/g, '').trim();
    if (onProgress) onProgress({ msg: `Playlist ${done}/${total}…`, percent: Math.round((done / Math.max(1, total)) * 100), current: label, done, total });

    let rel = relByKey.get(key) || (e.bySrc[pcPath] && e.bySrc[pcPath].deviceRel);
    let exists = false;
    if (rel) {
      try { await fsP.stat(path.join(musicDir, rel)); exists = true; } catch {}
    }
    if (!exists) {
      try {
        const artistDir = await resolveArtistDirAsync(musicDir, tags.artist);
        await fsP.mkdir(artistDir, { recursive: true });
        const destName = sanitizeName(path.basename(pcPath).replace(/\.mp3$/i, '')) + '.mp3';
        const dest = await uniquePathAsync(path.join(artistDir, destName));
        await fsP.copyFile(pcPath, dest);
        rel = path.relative(musicDir, dest).replace(/\\/g, '/');
        e.keys[key] = { title: tags.title || '', artist: tags.artist || '', year: tags.year || '', fileName: path.basename(dest), syncedAt: Date.now() };
        e.bySrc[pcPath] = { key, deviceRel: rel, syncedAt: Date.now() };
        relByKey.set(key, rel);
        copied++;
      } catch { failed++; return; }
    }
    entries.push({ rel, label: label || path.basename(rel) });
  }), 3);

  let body = '#EXTM3U\n';
  for (const en of entries) body += `#EXTINF:-1,${en.label}\n${en.rel}\n`;
  let m3uName = sanitizeName(name || 'playlist') + '.m3u8';
  const m3uPath = path.join(musicDir, m3uName);
  try { await fsP.writeFile(m3uPath, body, 'utf-8'); } catch { }

  writeSyncState(syncPath, state);
  return { copied, failed, total, count: entries.length, m3u: m3uName };
}

module.exports = {
  scan, sync, syncPlaylist,
  syncKey, readSyncState, writeSyncState, readId3FastAsync
};

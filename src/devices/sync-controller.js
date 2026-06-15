/**
 * @module  devices/sync-controller
 * @badge   🟨 DEVICE · WORKER-THREAD · STATEFUL(devices/worker/timer) · FACTORY-DI
 * @role    Orquestra dispositivos: polling de conexão, estado por dispositivo (sync.json), worker de sync, scan/sync serializado por serial e escopo de sincronização.
 * @inputs  createSyncController({ send, readConfig, writeConfig, getLibraryDir, readId3Fast })
 * @outputs API: startPolling, dispose, connectedDevices(Map), deviceMusicDir, readSyncState/writeSyncState, syncKey, scanDevice, syncDevice, runSyncTask, SYNC_PATH
 * @deps    fs, path, electron(app), worker_threads(Worker), ../../i18n, ./device-detection
 * @notes   Estado vivo (Map de conectados, timer de polling, worker) selado na instância. Worker = ../../sync-worker.js. dispose() no before-quit. send/config/getLibraryDir/readId3Fast injetados.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { Worker } = require('worker_threads');
const i18n = require('../../i18n');
const t = i18n.t;
const { queryRemovableDrives } = require('./device-detection');

module.exports = function createSyncController({ send, readConfig, writeConfig, getLibraryDir, readId3Fast }) {
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
    syncWorker = new Worker(path.join(__dirname, '..', '..', 'sync-worker.js'));
    syncWorker.on('message', (m) => {
      const task = syncTasks.get(m.id);
      if (!task) return;
      if (m.type === 'progress') {
        if (task.onProgress) task.onProgress(m.payload || {});
      } else {
        syncTasks.delete(m.id);
        task.resolve(m.type === 'error' ? { error: m.error } : m.result);
      }
    });
    // falha geral do worker: resolve tudo que estava pendente e recria na próxima
    syncWorker.on('error', (err) => {
      for (const task of syncTasks.values()) task.resolve({ error: err.message });
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

  // limpeza no before-quit: para o polling e encerra o worker
  function dispose() {
    if (devicePollTimer) { clearInterval(devicePollTimer); devicePollTimer = null; }
    if (syncWorker) { try { syncWorker.terminate(); } catch { /* ok */ } syncWorker = null; }
  }

  return {
    startPolling: startDevicePolling,
    dispose,
    connectedDevices,
    deviceMusicDir,
    readSyncState,
    writeSyncState,
    syncKey,
    scanDevice,
    syncDevice,
    runSyncTask,
    SYNC_PATH
  };
};

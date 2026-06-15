// Controlador de sync: chave de identidade de faixa (src/devices/sync-controller.js).
// Instancia a factory com deps stub — não toca worker/áudio/Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import createSyncController from '../src/devices/sync-controller.js';

const ctrl = createSyncController({
  send() {}, readConfig: () => ({ devices: {} }), writeConfig() {},
  getLibraryDir: () => '.', readId3Fast: () => ({})
});

test('syncKey: title|artist|year normalizados (case/espaço)', () => {
  assert.equal(ctrl.syncKey('Title', 'Artist', '2020'), 'title|artist|2020');
  assert.equal(ctrl.syncKey('  A   B ', 'X', null), 'a b|x|');
  assert.equal(ctrl.syncKey('Música', 'Ar Tist', 1999), 'música|ar tist|1999');
});

test('API exposta tem as chaves esperadas', () => {
  for (const k of ['startPolling', 'dispose', 'connectedDevices', 'deviceMusicDir',
    'readSyncState', 'writeSyncState', 'syncKey', 'scanDevice', 'syncDevice', 'runSyncTask', 'SYNC_PATH']) {
    assert.ok(k in ctrl, `falta ${k}`);
  }
});

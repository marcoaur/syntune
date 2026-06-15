# src/devices — 🟨 Dispositivos & sincronização

Detecção de armazenamentos removíveis e sincronização PC↔dispositivo. O I/O pesado roda em worker thread (`sync-engine.js` via `sync-worker.js`, na raiz).

## Mapa de arquivos

| Arquivo | Badge | Responsabilidade única |
|---------|-------|------------------------|
| `device-detection.js` | 🟨 DEVICE · WIN-ONLY · CHILD-PROCESS | Consulta CIM/PowerShell → lista de volumes removíveis normalizados (serial HW/VOL, letra, rótulo, tamanhos) |
| `sync-controller.js` | 🟨 DEVICE · WORKER-THREAD · FACTORY-DI | Polling de conexão, estado por dispositivo (`sync.json`), worker de sync, scan/sync serializado por serial, escopo de sync |

## Fluxo de dados

```
startPolling() (8s)
   └► device-detection.queryRemovableDrives() ─► [drives]
        └► reconcileDevices ─► onDeviceAttached ─► send('device:attached'|'device:detached')
                                       │ readConfig/writeConfig (cfg.devices)
scanDevice/syncDevice(serial)
   └► deviceTaskParams (musicDir + libraryDir + scope + sync.json) ─► runSyncTask
        └► Worker(../../sync-worker.js) ◄═══ progresso ═══► onProgress ─► send('sync:progress')
                 │ resultado
   sincronização SERIALIZADA por serial (guard.rerun se mudou durante a execução)
```

**Insumos:** SO (volumes USB), `cfg.devices` (config), `sync.json` (estado), biblioteca do PC.
**Saídas:** eventos IPC (`device:attached/detached`, `sync:progress`), `sync.json` atualizado, cópias no dispositivo.

## Contratos

- `device-detection`: `queryRemovableDrives()` → `Promise<drives[]>` (+ `normalizeDrive`/`cleanSerial`). Só Windows. Deps: `child_process`.
- `sync-controller`: **factory** `createSyncController({ send, readConfig, writeConfig, getLibraryDir, readId3Fast })` → `{ startPolling, dispose, connectedDevices, deviceMusicDir, readSyncState, writeSyncState, syncKey, scanDevice, syncDevice, runSyncTask, SYNC_PATH }`. Estado vivo selado na instância.
- `main.js` mantém os handlers `ipcMain` (devices:*, device:*, playlist:*) finos, consumindo a API destruturada com os mesmos nomes.

## Invariantes

1. Sync **serializada por dispositivo** (`syncing` Map + `guard.rerun`) — nunca cópia concorrente no mesmo serial.
2. `dispose()` no `before-quit`: para o timer de polling e encerra o worker (senão o processo não morre).
3. Worker recriado sob demanda após erro/exit (`ensureSyncWorker`).
4. Serial efetivo prefere hardware (`HW:`) e cai p/ volume (`VOL:`) — estabilidade entre replugues.
5. `device:deleteTrack` valida que o alvo está dentro de `musicDir` (sem path traversal).

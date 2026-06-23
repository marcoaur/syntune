/**
 * @module  ipc/contract
 * @badge   ⬜ UTIL · IPC-CONTRACT · TYPES-ONLY · NO-RUNTIME
 * @role    Contrato type-safe (1ª leva, sem TS) renderer↔main: tipos JSDoc por canal
 *          (payload + retorno). preload, handlers do main e ApiService referenciam estes
 *          tipos. Ver FRONTEND-MIGRATION.md Fase A + MAIN-MIGRATION.md.
 * @notes   Sem .ts e sem build novo. Trampolim p/ a futura migração TS (os tipos JSDoc
 *          convertem direto). Ative ts-check nos arquivos que consomem.
 */

// ---------------------------------------------------------------------------
// Tipos de domínio (crescem conforme as ilhas migram).
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} I18nPayload
 * @property {Record<string,string>} strings  dicionário chave→texto
 * @property {string} lang                     idioma resolvido (ex.: 'pt-br')
 */

/**
 * @typedef {Object} ChordEvent
 * @property {number} time   tempo (s) do acorde
 * @property {string} label  rótulo (ex.: 'C', 'Am7')
 */

/**
 * Tags lidas/escritas de um MP3 (subconjunto estável; refina conforme migra).
 * @typedef {Object} TrackTags
 * @property {string} [title]
 * @property {string} [artist]
 * @property {string} [album]
 * @property {string} [year]
 * @property {string} [genre]
 * @property {string} [lyrics]  letra (texto puro ou LRC sincronizado)
 * @property {string} [chords]  acordes sincronizados (timeline LRC própria)
 */

/**
 * Superfície de `window.api` exposta pelo preload (contextBridge). É O CONTRATO
 * renderer↔main: preload IMPLEMENTA, ApiService CONSOME. Tipos frouxos (`any`) onde o
 * payload ainda não foi modelado — refina por canal conforme as ilhas migram. Trampolim
 * direto p/ a futura interface TS (§5).
 * @typedef {Object} IpcApi
 * @property {() => void} minimize
 * @property {() => void} close
 * @property {(cb: () => void) => void} onAppFadeout
 * @property {() => void} fadeoutDone
 * @property {() => Promise<boolean>} toggleFullscreen
 * @property {(on: boolean) => Promise<boolean>} setFullscreen
 * @property {() => Promise<string>} getTheme
 * @property {(cb: (theme: string) => void) => void} onThemeChanged
 * @property {() => Promise<string>} getVersion
 * @property {() => Promise<I18nPayload>} getI18n
 * @property {(lang: string) => Promise<I18nPayload>} setLanguage
 * @property {() => Promise<Record<string, any>>} getConfig
 * @property {(cfg: Record<string, any>) => Promise<any>} setConfig
 * @property {() => Promise<any>} cliDetect
 * @property {(enabled: boolean) => Promise<any>} cliSetAiEnabled
 * @property {(cb: () => void) => void} onSecurityWarning
 * @property {(cb: (info: any) => void) => void} onUpdateReady
 * @property {() => void} installUpdate
 * @property {() => Promise<string|null>} selectMp3
 * @property {() => Promise<string|null>} selectImage
 * @property {() => Promise<string|null>} selectFolder
 * @property {(filePath: string) => Promise<TrackTags>} readTags
 * @property {(payload: any) => Promise<any>} saveTags
 * @property {(filePath: string) => Promise<string|null>} getCover
 * @property {() => Promise<any[]>} libraryList
 * @property {(filePath: string) => Promise<any>} libraryDelete
 * @property {(filePath: string) => Promise<any>} libraryImport
 * @property {(imagePath: string) => Promise<string|null>} imagePreview
 * @property {(payload: any) => Promise<any>} artistImage
 * @property {(payload: any) => Promise<any>} fetchSyncedLyrics
 * @property {(filePath: string) => Promise<any>} enrichLyricsFile
 * @property {(payload: any) => Promise<any>} lyricsPublish
 * @property {(filePath: string) => Promise<any>} lyricsGetSyncStatus
 * @property {(filePath: string, status: any) => Promise<any>} lyricsSetSyncStatus
 * @property {(filePath: string) => Promise<string>} chordsGet
 * @property {(filePath: string, chords: string) => Promise<any>} chordsSet
 * @property {(payload: any) => Promise<any>} lastfmGetPlaycount
 * @property {(payload: any) => Promise<any>} lastfmGetArtistInfo
 * @property {(payload: any) => Promise<any>} lastfmAuthSession
 * @property {(payload: any) => Promise<any>} lastfmScrobble
 * @property {(payload: any) => Promise<any>} youtubeDownload
 * @property {(cb: (data: any) => void) => void} onYoutubeProgress
 * @property {(context: any) => Promise<any>} fetchMetadata
 * @property {(payload: any) => Promise<any>} smartMetadata
 * @property {(cb: (data: any) => void) => void} onGeminiProgress
 * @property {() => Promise<any[]>} devicesList
 * @property {(payload: any) => Promise<any>} devicesUpdate
 * @property {(serial: string) => Promise<any>} deviceScan
 * @property {(serial: string) => Promise<any>} deviceSync
 * @property {(serial: string) => Promise<any>} deviceSyncState
 * @property {(payload: any) => Promise<any>} deviceEnrichFromDevice
 * @property {(payload: any) => Promise<any>} deviceDeleteTrack
 * @property {(payload: any) => Promise<any>} playlistExportM3u
 * @property {(payload: any) => Promise<any>} playlistSyncToDevice
 * @property {(cb: (info: any) => void) => void} onDeviceAttached
 * @property {(cb: (info: any) => void) => void} onDeviceDetached
 * @property {(cb: (data: any) => void) => void} onSyncProgress
 * @property {(file: File) => string} getFilePath
 */

// ---------------------------------------------------------------------------
// Mapa dos canais IPC (nome → direção). Documental + base p/ validação futura.
// invoke = request/response (ipcRenderer.invoke ↔ ipcMain.handle)
// send    = fire-and-forget (ipcRenderer.send ↔ ipcMain.on)
// on      = push do main → renderer (webContents.send ↔ ipcRenderer.on)
// ---------------------------------------------------------------------------
const contract = Object.freeze({
  // janela
  'window:minimize': 'send',
  'window:close': 'send',
  'window:toggleFullscreen': 'invoke',
  'window:setFullscreen': 'invoke',
  'app:fadeout': 'on',
  'app:fadeoutDone': 'send',
  // tema / versão / i18n
  'theme:get': 'invoke',
  'theme:changed': 'on',
  'app:getVersion': 'invoke',
  'i18n:get': 'invoke',
  'i18n:setLanguage': 'invoke',
  // config
  'config:get': 'invoke',
  'config:set': 'invoke',
  // mp3 / biblioteca
  'mp3:readTags': 'invoke',
  'mp3:saveTags': 'invoke',
  'mp3:cover': 'invoke',
  'library:list': 'invoke',
  'library:delete': 'invoke',
  'library:import': 'invoke',
  // letras / acordes
  'lyrics:fetchSynced': 'invoke',
  'lyrics:enrichFile': 'invoke',
  'chords:get': 'invoke',
  'chords:set': 'invoke',
  // dispositivos
  'devices:list': 'invoke',
  'device:sync': 'invoke',
  'device:attached': 'on',
  'device:detached': 'on',
  'sync:progress': 'on',
});

/** @typedef {keyof typeof contract} IpcChannel */

module.exports = { contract };

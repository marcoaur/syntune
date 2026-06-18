/**
 * @module  preload
 * @badge   🟥 CORE · IPC-BRIDGE · CONTEXT-ISOLATED
 * @role    Única ponte renderer↔main: expõe `window.api` (invoke/send/on) via contextBridge. Renderer não acessa Node direto.
 * @inputs  chamadas de window.api no renderer
 * @outputs ipcRenderer.invoke/send/on encapsulados
 * @deps    electron (contextBridge, ipcRenderer, webUtils)
 * @notes   Toda nova IPC precisa de handler em main.js E método exposto aqui.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // controles da janela
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
  onAppFadeout: (cb) => ipcRenderer.on('app:fadeout', () => cb()),
  fadeoutDone: () => ipcRenderer.send('app:fadeoutDone'),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggleFullscreen'),
  setFullscreen: (on) => ipcRenderer.invoke('window:setFullscreen', on),

  // tema do sistema
  getTheme: () => ipcRenderer.invoke('theme:get'),
  onThemeChanged: (cb) => ipcRenderer.on('theme:changed', (_e, t) => cb(t)),

  // versão do app
  getVersion: () => ipcRenderer.invoke('app:getVersion'),

  // idioma e textos da interface
  getI18n: () => ipcRenderer.invoke('i18n:get'),
  setLanguage: (lang) => ipcRenderer.invoke('i18n:setLanguage', lang),

  // configuração
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),

  // integração com o Syntune CLI
  cliDetect: () => ipcRenderer.invoke('cli:detect'),
  cliSetAiEnabled: (enabled) => ipcRenderer.invoke('cli:setAiEnabled', enabled),
  onSecurityWarning: (cb) => ipcRenderer.on('security:plaintextWarning', () => cb()),

  // auto-update
  onUpdateReady: (cb) => ipcRenderer.on('update:ready', (_e, info) => cb(info)),
  installUpdate: () => ipcRenderer.send('update:install'),

  // seleção de arquivos
  selectMp3: () => ipcRenderer.invoke('dialog:selectMp3'),
  selectImage: () => ipcRenderer.invoke('dialog:selectImage'),
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),

  // mp3
  readTags: (filePath) => ipcRenderer.invoke('mp3:readTags', filePath),
  saveTags: (payload) => ipcRenderer.invoke('mp3:saveTags', payload),
  getCover: (filePath) => ipcRenderer.invoke('mp3:cover', filePath),

  // biblioteca
  libraryList: () => ipcRenderer.invoke('library:list'),
  libraryDelete: (filePath) => ipcRenderer.invoke('library:delete', filePath),
  libraryImport: (filePath) => ipcRenderer.invoke('library:import', filePath),

  // imagem
  imagePreview: (imagePath) => ipcRenderer.invoke('image:preview', imagePath),

  // foto do artista (Genius)
  artistImage: (payload) => ipcRenderer.invoke('artist:image', payload),

  // letra sincronizada (LRCLIB)
  fetchSyncedLyrics: (payload) => ipcRenderer.invoke('lyrics:fetchSynced', payload),
  enrichLyricsFile: (filePath) => ipcRenderer.invoke('lyrics:enrichFile', { filePath }),
  lyricsPublish: (payload) => ipcRenderer.invoke('lyrics:publish', payload),
  lyricsGetSyncStatus: (filePath) => ipcRenderer.invoke('lyrics:getSyncStatus', filePath),
  lyricsSetSyncStatus: (filePath, status) => ipcRenderer.invoke('lyrics:setSyncStatus', { filePath, status }),

  // lastfm
  lastfmGetPlaycount: (payload) => ipcRenderer.invoke('lastfm:getPlaycount', payload),
  lastfmGetArtistInfo: (payload) => ipcRenderer.invoke('lastfm:getArtistInfo', payload),
  lastfmAuthSession: (payload) => ipcRenderer.invoke('lastfm:authSession', payload),
  lastfmScrobble: (payload) => ipcRenderer.invoke('lastfm:scrobble', payload),

  // youtube
  youtubeDownload: (payload) => ipcRenderer.invoke('youtube:download', payload),
  onYoutubeProgress: (cb) => ipcRenderer.on('youtube:progress', (_e, data) => cb(data)),

  // gemini
  fetchMetadata: (context) => ipcRenderer.invoke('gemini:fetchMetadata', context),
  smartMetadata: (payload) => ipcRenderer.invoke('gemini:smartMetadata', payload),
  onGeminiProgress: (cb) => ipcRenderer.on('gemini:progress', (_e, data) => cb(data)),

  // dispositivos de armazenamento / sincronização
  devicesList: () => ipcRenderer.invoke('devices:list'),
  devicesUpdate: (payload) => ipcRenderer.invoke('devices:update', payload),
  deviceScan: (serial) => ipcRenderer.invoke('device:scan', { serial }),
  deviceSync: (serial) => ipcRenderer.invoke('device:sync', { serial }),
  deviceSyncState: (serial) => ipcRenderer.invoke('device:syncState', { serial }),
  deviceEnrichFromDevice: (payload) => ipcRenderer.invoke('device:enrichFromDevice', payload),
  deviceDeleteTrack: (payload) => ipcRenderer.invoke('device:deleteTrack', payload),
  playlistExportM3u: (payload) => ipcRenderer.invoke('playlist:exportM3u', payload),
  playlistSyncToDevice: (payload) => ipcRenderer.invoke('playlist:syncToDevice', payload),
  onDeviceAttached: (cb) => ipcRenderer.on('device:attached', (_e, info) => cb(info)),
  onDeviceDetached: (cb) => ipcRenderer.on('device:detached', (_e, info) => cb(info)),
  onSyncProgress: (cb) => ipcRenderer.on('sync:progress', (_e, data) => cb(data)),

  // resolve o caminho absoluto de um arquivo arrastado para a janela
  getFilePath: (file) => webUtils.getPathForFile(file)
});

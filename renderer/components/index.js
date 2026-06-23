// Barrel da camada Lit (Fase A). Reúne base, mixins, controllers, serviços e o provider
// raiz num só ponto de importação. Também serve de entry SECUNDÁRIO do electron-vite
// build: garante que todo o grafo Lit compile (sintaxe + resolução de 'lit'/@lit/context)
// SEM tocar no renderer.js legado. As ilhas reais importam daqui conforme migram.
export { SyntuneElement } from './base/syntune-element.js';
export { ContainerMixin } from './base/container-mixin.js';
export { RafController } from './controllers/raf-controller.js';
export { MediaTimeController } from './controllers/media-time-controller.js';
export { sharedStyles, tokens, primitives } from './styles/shared-styles.js';
export { SynAppRoot } from './app-root.js';
export { SynChordLine } from './chord/syn-chord-line.js';
export { SynChordMark } from './chord/syn-chord-mark.js';
export { SynSwitch } from './control/syn-switch.js';
export { SynIcon } from './control/syn-icon.js';
export { SynRange } from './control/syn-range.js';
export { SynSyncBadge } from './control/syn-sync-badge.js';
export { SynSettingSection } from './setting/syn-setting-section.js';
export { SynEq } from './panel/syn-eq.js';
export { SynCropper } from './panel/syn-cropper.js';
export { SynToast } from './panel/syn-toast.js';
export { SynDevice } from './device/syn-device.js';
export { SynPlaylistCard } from './playlist/syn-playlist-card.js';
export { SynSongCard } from './song/syn-song-card.js';
export { SynQueueItem } from './queue/syn-queue-item.js';
export { SynMiniPlayer } from './player/syn-mini-player.js';
export { SynVisualizer } from './visualizer/syn-visualizer.js';
export { SynLyrics } from './lyrics/syn-lyrics.js';

export {
  apiContext, playerContext, libraryContext, paletteContext,
  settingsContext, i18nContext, devicesContext, toastContext,
} from '../services/contexts.js';
export { ApiService } from '../services/api-service.js';
export { PlayerService } from '../services/player-service.js';
export { LibraryService } from '../services/library-service.js';
export { PaletteService } from '../services/palette-service.js';
export { SettingsService } from '../services/settings-service.js';
export { I18nService } from '../services/i18n-service.js';
export { DevicesService } from '../services/devices-service.js';
export { ToastService } from '../services/toast-service.js';

// Contexts (@lit/context) — chaves de injeção dos serviços (contrato §2.1).
// Os serviços são providos UMA vez no <app-root> e consumidos pelos componentes via
// `@consume({ context: playerContext })`. Regra: componente nunca importa window.api
// direto — só via ApiService (apiContext).
import { createContext } from '@lit/context';

export const apiContext = createContext(Symbol('syn:api'));
export const playerContext = createContext(Symbol('syn:player'));
export const libraryContext = createContext(Symbol('syn:library'));
export const paletteContext = createContext(Symbol('syn:palette'));
export const settingsContext = createContext(Symbol('syn:settings'));
export const i18nContext = createContext(Symbol('syn:i18n'));
export const devicesContext = createContext(Symbol('syn:devices'));
export const toastContext = createContext(Symbol('syn:toast'));

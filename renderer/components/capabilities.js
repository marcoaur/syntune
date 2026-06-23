// Acessores das CAPACIDADES headless (ARCHITECTURE-V2). Mesmo espírito do `toast()`:
// quem precisa importa e usa; o elemento singleton é montado no body sob demanda (portal,
// escapa stacking-context). Cada capacidade é um custom element autossuficiente em
// components/capability/. Conforme a Fase 1 avança, entram aqui: confirm, menu, palette.
import './capability/syn-loading.js';

let _loading;
/** Overlay de carregamento. `loading().show(msg)` / `loading().hide()`. */
export function loading() {
  if (!_loading) {
    _loading = document.createElement('syn-loading');
    document.body.appendChild(_loading);
  }
  return _loading;
}

// Acessores das CAPACIDADES headless (ARCHITECTURE-V2). Mesmo espírito do `toast()`:
// quem precisa importa e usa; o elemento singleton é montado no body sob demanda (portal,
// escapa stacking-context). Cada capacidade é um custom element autossuficiente em
// components/capability/. Conforme a Fase 1 avança, entram aqui: confirm, menu, palette.
import './capability/syn-loading.js';
import './capability/syn-confirm.js';
import { PaletteCapability } from './capability/palette.js';

let _loading;
/** Overlay de carregamento. `loading().show(msg)` / `loading().hide()`. */
export function loading() {
  if (!_loading) {
    _loading = document.createElement('syn-loading');
    document.body.appendChild(_loading);
  }
  return _loading;
}

let _confirm;
/** Diálogo de confirmação. `await confirm().ask({message,danger,confirmLabel,cancelLabel})` → bool. */
export function confirm() {
  if (!_confirm) {
    _confirm = document.createElement('syn-confirm');
    document.body.appendChild(_confirm);
  }
  return _confirm;
}

let _palette;
/** Cor-chave da capa (compute + cache). `await palette().of(url)` → {r,g,b,text}|null. */
export function palette() {
  if (!_palette) _palette = new PaletteCapability();
  return _palette;
}

/**
 * @module  renderer/icons
 * @badge   ⬜ UTIL · RENDERER · DATA(SVG) · ESM
 * @role    Conjunto de ícones SVG inline (traço fino / preenchido), herdam cor via currentColor. Tabela imutável consumida por applyPlayerIcons e cards.
 * @inputs  (nenhum)   @outputs ICONS: Record<string, string(svg)>
 * @deps    (nenhum)
 */
const _svgStroke = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const _svgFill = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">${paths}</svg>`;
const ICONS = {
  play: _svgFill('<path d="M8 5v14l11-7z"/>'),
  pause: _svgFill('<path d="M7 5h3v14H7z"/><path d="M14 5h3v14h-3z"/>'),
  prev: _svgFill('<path d="M7 5h2.4v14H7z"/><path d="M20 5v14L9 12z"/>'),
  next: _svgFill('<path d="M14.6 5H17v14h-2.4z"/><path d="M4 5v14l11-7z"/>'),
  shuffle: _svgStroke('<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/>'),
  repeat: _svgStroke('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'),
  repeatOne: _svgStroke('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10h1v4"/>'),
  queue: _svgStroke('<path d="M21 15V6"/><circle cx="18.5" cy="15.5" r="2.5"/><path d="M12 12H3"/><path d="M16 6H3"/><path d="M12 18H3"/>'),
  volume: _svgStroke('<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>'),
  close: _svgStroke('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  chevron: _svgStroke('<path d="m9 6 6 6-6 6"/>'),
  chevronDown: _svgStroke('<path d="m6 9 6 6 6-6"/>'),
  expandUp: _svgStroke('<path d="m6 15 6-6 6 6"/>'),
  eq: _svgStroke('<line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="1" x2="7" y1="14" y2="14"/><line x1="9" x2="15" y1="8" y2="8"/><line x1="17" x2="23" y1="16" y2="16"/>'),
  trash: _svgStroke('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  maximize: _svgStroke('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'),
  edit: _svgStroke('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  grip: _svgStroke('<circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/>'),
  lyrics: _svgStroke('<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>'),
  plusSm: _svgStroke('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  minimize: _svgStroke('<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>')
};

export { ICONS };

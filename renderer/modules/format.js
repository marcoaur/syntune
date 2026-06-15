/**
 * @module  renderer/format
 * @badge   ⬜ UTIL · RENDERER · PURE · ESM
 * @role    Helpers puros de formatação/normalização usados pela UI: chaves de faixa, normalização de texto, escape HTML, bytes/dB, CSS.escape.
 * @inputs  strings/números/objetos de faixa
 * @outputs strings normalizadas/formatadas
 * @deps    (nenhum) — DOM/window só em call-time (escapeHtmlText/cssEsc)
 */
export function normPart(s) { return (s == null ? '' : String(s)).toLowerCase().trim().replace(/\s+/g, ' '); }

export function keyOf(s) {
  return `${normPart(s.title)}|${normPart(s.artist)}|${(s.year == null ? '' : String(s.year)).trim()}`;
}

export function normalizeText(s) {
  return (s == null ? '' : String(s)).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

export function artistInitials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '♪';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function escapeHtmlText(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

export function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : s; }

export function fmtBytes(n) {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${(n >= 10 || i === 0) ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

export function fmtDb(g) { return `${g > 0 ? '+' : ''}${g} dB`; }

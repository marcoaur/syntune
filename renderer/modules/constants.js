/**
 * @module  renderer/constants
 * @badge   ⬜ UTIL · RENDERER · DATA · ESM
 * @role    Tabelas/constantes de dados puros da UI: estados de letra (rótulos+classes), bandas do equalizador e presets embutidos.
 * @inputs  (nenhum)
 * @outputs objetos/arrays imutáveis de configuração
 * @deps    (nenhum) — labels de preset são chaves i18n resolvidas no render
 */

// 5 estados claros do fluxo de letra (rótulos PT fixos + classes CSS de badge/dot)
// Os textos vêm do i18n (titleKey/subKey/badgeKey, resolvidos com t() no render);
// aqui ficam só as chaves i18n + as classes CSS de cada estado.
export const LYRICS_STATUS = {
  // Sem letra, nunca buscou no LRCLIB
  empty: {
    titleKey: 'lyrics.status.empty.title', subKey: 'lyrics.status.empty.sub',
    dotCls: 'lm-status-dot--pending',
    badgeCls: 'ev-lyrics-badge--pending', badgeKey: 'lyrics.badge.empty'
  },
  // Buscou no LRCLIB, não encontrou nada
  not_found: {
    titleKey: 'lyrics.status.not_found.title', subKey: 'lyrics.status.not_found.sub',
    dotCls: 'lm-status-dot--not_found',
    badgeCls: 'ev-lyrics-badge--not_found', badgeKey: 'lyrics.badge.not_found'
  },
  // Tem letra mas origem desconhecida (arquivo antigo sem tag)
  pending: {
    titleKey: 'lyrics.status.pending.title', subKey: 'lyrics.status.pending.sub',
    dotCls: 'lm-status-dot--local',
    badgeCls: 'ev-lyrics-badge--local', badgeKey: 'lyrics.badge.pending'
  },
  // Letra criada/editada localmente, não publicada no LRCLIB
  local: {
    titleKey: 'lyrics.status.local.title', subKey: 'lyrics.status.local.sub',
    dotCls: 'lm-status-dot--local',
    badgeCls: 'ev-lyrics-badge--local', badgeKey: 'lyrics.badge.local'
  },
  // Letra veio do LRCLIB ou foi publicada lá com sucesso
  synced: {
    titleKey: 'lyrics.status.synced.title', subKey: 'lyrics.status.synced.sub',
    dotCls: 'lm-status-dot--synced',
    badgeCls: 'ev-lyrics-badge--synced', badgeKey: 'lyrics.badge.synced'
  }
};

// bandas do equalizador (frequência, tipo de filtro BiquadFilter e rótulo)
export const EQ_BANDS = [
  { f: 80, type: 'lowshelf', label: '80' },
  { f: 200, type: 'peaking', label: '200' },
  { f: 600, type: 'peaking', label: '600' },
  { f: 2000, type: 'peaking', label: '2k' },
  { f: 5000, type: 'peaking', label: '5k' },
  { f: 12000, type: 'highshelf', label: '12k' }
];

// presets embutidos do equalizador (nameKey = chave i18n, resolvida no render)
export const EQ_BUILTINS = [
  { nameKey: 'eq.preset.flat', gains: [0, 0, 0, 0, 0, 0], builtin: true },
  { nameKey: 'eq.preset.bass', gains: [6, 4, 0, 0, 0, 1], builtin: true },
  { nameKey: 'eq.preset.voice', gains: [-2, -1, 2, 4, 2, 0], builtin: true },
  { nameKey: 'eq.preset.bright', gains: [0, 0, 0, 1, 4, 5], builtin: true },
  { nameKey: 'eq.preset.loudness', gains: [5, 2, 0, 0, 2, 4], builtin: true }
];

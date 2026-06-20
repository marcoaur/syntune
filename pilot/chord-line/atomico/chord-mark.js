// FILHO — <chord-mark> · Atomico (web component funcional + hooks)
// Props declaradas em .props (configurável), render puro a partir delas (idempotente),
// feedback padronizado via useEvent.
import { c, html, useEvent } from 'https://esm.sh/atomico@3';

function chordMark({ label, time, pos, glow, accent }) {
  const select = useEvent('chordmark-select', { bubbles: true, composed: true });
  const edit = useEvent('chordmark-edit', { bubbles: true, composed: true });
  const a = accent, g = glow;
  const style = 'position:absolute;top:0;cursor:pointer;white-space:nowrap;font:800 13px/1 system-ui;'
    + `left:calc(28px + ${pos} * (100% - 56px));`
    + `color:rgba(${a},${0.72 + 0.28 * g});`
    + `text-shadow:${g > 0.02 ? `0 0 ${12 * g}px rgba(${a},${0.6 * g})` : 'none'};`
    + `transform:translateX(-50%) scale(${1 + 0.16 * g})`;
  return html`<host shadowDom style=${style}
      onclick=${() => select({ time, label })}
      ondblclick=${() => edit({ time, label })}>${label}</host>`;
}
chordMark.props = {
  label: { type: String, value: '' },
  time: { type: Number, value: 0 },
  pos: { type: Number, value: 0 },
  glow: { type: Number, value: 0 },
  accent: { type: String, value: '150,130,255' },
};
customElements.define('chord-mark', c(chordMark));

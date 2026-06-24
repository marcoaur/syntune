// CONTAINER — <chord-line> · Atomico
// Descobre os filhos pela categoria, orquestra pos/glow/accent + barra (useEffect),
// re-emite o feedback padronizado.
import { c, html, useHost, useEffect, useEvent } from 'https://esm.sh/atomico@3';
import './chord-mark.js';

function chordLine({ start, end, current, accent }) {
  const host = useHost();
  const relaySelect = useEvent('chordline-select', { bubbles: true, composed: true });
  const relayEdit = useEvent('chordline-edit', { bubbles: true, composed: true });

  // ouve o feedback dos filhos (uma vez) e re-emite padronizado
  useEffect(() => {
    const el = host.current;
    const onSel = (e) => relaySelect(e.detail);
    const onEdit = (e) => relayEdit(e.detail);
    el.addEventListener('chordmark-select', onSel);
    el.addEventListener('chordmark-edit', onEdit);
    return () => { el.removeEventListener('chordmark-select', onSel); el.removeEventListener('chordmark-edit', onEdit); };
  }, []);

  // orquestra os filhos a cada mudança de props (props down)
  useEffect(() => {
    const span = Math.max(0.1, end - start);
    host.current.querySelectorAll('chord-mark').forEach((m) => {
      m.accent = accent;
      m.pos = Math.min(1, Math.max(0, (m.time - start) / span));
      m.glow = current >= m.time ? Math.max(0, 1 - (current - m.time) / 1.6) : 0;
    });
  });

  const span = Math.max(0.1, end - start);
  const p = Math.min(1, Math.max(0, (current - start) / span));
  const at = (f) => `calc(28px + ${f} * (100% - 56px))`;
  return html`<host shadowDom
      style=${`--acc:${accent};position:relative;display:block;height:26px;max-width:760px;margin:0 auto`}>
    <style>
      .sweep{position:absolute;left:0;bottom:1px;height:2px;border-radius:2px;background:linear-gradient(90deg,rgba(var(--acc),0),rgba(var(--acc),.55))}
      .head{position:absolute;bottom:0;width:5px;height:5px;border-radius:50%;transform:translateX(-50%);background:rgb(var(--acc));box-shadow:0 0 8px 2px rgba(var(--acc),.75)}
    </style>
    <div class="sweep" style=${`width:${at(p)}`}></div>
    <div class="head" style=${`left:${at(p)}`}></div>
    <slot></slot>
  </host>`;
}
chordLine.props = {
  start: { type: Number, value: 0 }, end: { type: Number, value: 1 },
  current: { type: Number, value: 0 }, accent: { type: String, value: '150,130,255' },
};
customElements.define('chord-line', c(chordLine));

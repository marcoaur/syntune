// Teste do syn-switch (DoD §3 — props→render + evento + a11y). Confirma que o padrão A
// generaliza p/ uma ilha de controle. Roda via `npm run test:wc`.
import { fixture, html, expect, oneEvent } from '@open-wc/testing';
import './index.js';

describe('syn-switch (folha controle / arquétipo A)', () => {
  it('reflete checked no ARIA (role switch)', async () => {
    const el = await fixture(html`<syn-switch .checked=${true}></syn-switch>`);
    const btn = el.shadowRoot.querySelector('button');
    expect(btn.getAttribute('role')).to.equal('switch');
    expect(btn.getAttribute('aria-checked')).to.equal('true');
  });

  it('alterna e emite syn:control:change (bubbles+composed) ao clicar', async () => {
    const el = await fixture(html`<syn-switch></syn-switch>`);
    setTimeout(() => el.shadowRoot.querySelector('button').click());
    const e = await oneEvent(el, 'syn:control:change');
    expect(e.detail).to.deep.equal({ checked: true });
    expect(e.composed).to.be.true;
    expect(el.checked).to.be.true;
  });

  it('disabled não alterna nem emite', async () => {
    const el = await fixture(html`<syn-switch ?disabled=${true}></syn-switch>`);
    let fired = false;
    el.addEventListener('syn:control:change', () => { fired = true; });
    el.shadowRoot.querySelector('button').click();
    await el.updateComplete;
    expect(el.checked).to.be.false;
    expect(fired).to.be.false;
  });

  it('é idempotente: mesmo checked → mesmo aria', async () => {
    const el = await fixture(html`<syn-switch .checked=${true}></syn-switch>`);
    el.checked = true;
    await el.updateComplete;
    expect(el.shadowRoot.querySelector('button').getAttribute('aria-checked')).to.equal('true');
  });
});

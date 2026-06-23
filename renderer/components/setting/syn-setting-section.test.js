// Teste do syn-setting-section (DoD §3). Accordion: open→render + toggle emite + a11y.
import { fixture, html, expect, oneEvent } from '@open-wc/testing';
import './index.js';

describe('syn-setting-section (setting)', () => {
  it('aria-expanded reflete open', async () => {
    const el = await fixture(html`<syn-setting-section heading="IA" .open=${true}></syn-setting-section>`);
    expect(el.shadowRoot.querySelector('.head').getAttribute('aria-expanded')).to.equal('true');
  });
  it('clicar no header alterna e emite syn:setting:toggle', async () => {
    const el = await fixture(html`<syn-setting-section heading="IA"></syn-setting-section>`);
    setTimeout(() => el.shadowRoot.querySelector('.head').click());
    const e = await oneEvent(el, 'syn:setting:toggle');
    expect(e.detail).to.deep.equal({ open: true });
    expect(el.open).to.be.true;
  });
});

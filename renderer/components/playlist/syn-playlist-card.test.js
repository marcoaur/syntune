// Teste do syn-playlist-card (DoD §3). Light-DOM: querySelector direto.
import { fixture, html, expect, oneEvent } from '@open-wc/testing';
import './index.js';

describe('syn-playlist-card (playlist / Fase C)', () => {
  it('renderiza nome, sub e capa; vira .pl-card', async () => {
    const el = await fixture(html`<syn-playlist-card pid="p1" name="Rock" sub="12 faixas" .coverHtml=${'<span class="pl-cover-ph">x</span>'}></syn-playlist-card>`);
    await el.updateComplete;
    expect(el.classList.contains('pl-card')).to.be.true;
    expect(el.querySelector('.pl-card-name').textContent).to.equal('Rock');
    expect(el.querySelector('.pl-card-sub').textContent).to.equal('12 faixas');
    expect(el.querySelector('.pl-cover .pl-cover-ph')).to.exist;
  });

  it('clicar emite syn:playlist:open {id}', async () => {
    const el = await fixture(html`<syn-playlist-card pid="p9" name="X"></syn-playlist-card>`);
    await el.updateComplete;
    setTimeout(() => el.click());
    const e = await oneEvent(el, 'syn:playlist:open');
    expect(e.detail).to.deep.equal({ id: 'p9' });
    expect(e.composed).to.be.true;
  });

  it('Enter no card também abre (a11y teclado)', async () => {
    const el = await fixture(html`<syn-playlist-card pid="p2" name="Y"></syn-playlist-card>`);
    await el.updateComplete;
    setTimeout(() => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })));
    const e = await oneEvent(el, 'syn:playlist:open');
    expect(e.detail.id).to.equal('p2');
  });
});

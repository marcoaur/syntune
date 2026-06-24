// Testes dos painéis syn-eq e syn-cropper (DoD §3). Compõem folhas; props→render + eventos.
import { fixture, html, expect, oneEvent } from '@open-wc/testing';
import './index.js';

// 2x2 PNG (data URL) p/ o cropper carregar no headless.
const PNG_2x2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGNkYPjPgAcw4ZMEAB1pAQ9rB1rwAAAAAElFTkSuQmCC';

describe('syn-eq (panel)', () => {
  it('monta 6 bandas (syn-range) + 1 toggle (syn-switch)', async () => {
    const el = await fixture(html`<syn-eq .gains=${[0, 0, 0, 0, 0, 0]}></syn-eq>`);
    await el.updateComplete;
    expect(el.shadowRoot.querySelectorAll('syn-range').length).to.equal(6);
    expect(el.shadowRoot.querySelector('syn-switch')).to.exist;
  });
  it('mover uma banda emite syn:eq:change com gains atualizados', async () => {
    const el = await fixture(html`<syn-eq .gains=${[0, 0, 0, 0, 0, 0]}></syn-eq>`);
    await el.updateComplete;
    const r = el.shadowRoot.querySelector('syn-range');
    setTimeout(() => r.dispatchEvent(new CustomEvent('syn:control:change', { detail: { value: 5 }, bubbles: true, composed: true })));
    const e = await oneEvent(el, 'syn:eq:change');
    expect(e.detail.gains[0]).to.equal(5);
  });
  it('zerar emite gains todos 0', async () => {
    const el = await fixture(html`<syn-eq .gains=${[3, 3, 3, 3, 3, 3]}></syn-eq>`);
    await el.updateComplete;
    setTimeout(() => el.shadowRoot.querySelector('.flat').click());
    const e = await oneEvent(el, 'syn:eq:change');
    expect(e.detail.gains).to.deep.equal([0, 0, 0, 0, 0, 0]);
  });
});

describe('syn-cropper (panel)', () => {
  it('renderiza a imagem da src', async () => {
    const el = await fixture(html`<syn-cropper .src=${PNG_2x2}></syn-cropper>`);
    expect(el.shadowRoot.querySelector('.crop-img').getAttribute('src')).to.equal(PNG_2x2);
  });
  it('aplicar emite syn:cover:crop com dataUrl', async () => {
    const el = await fixture(html`<syn-cropper .src=${PNG_2x2}></syn-cropper>`);
    const img = el.shadowRoot.querySelector('.crop-img');
    if (!img.complete) await new Promise((r) => img.addEventListener('load', r, { once: true }));
    await el.updateComplete;
    setTimeout(() => el.shadowRoot.querySelectorAll('.btn')[1].click());
    const e = await oneEvent(el, 'syn:cover:crop');
    expect(e.detail.dataUrl).to.match(/^data:image\/jpeg/);
  });
  it('cancelar emite syn:cover:cancel', async () => {
    const el = await fixture(html`<syn-cropper .src=${PNG_2x2}></syn-cropper>`);
    setTimeout(() => el.shadowRoot.querySelector('.btn-ghost').click());
    const e = await oneEvent(el, 'syn:cover:cancel');
    expect(e).to.exist;
  });
});

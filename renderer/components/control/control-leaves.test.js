// Testes das folhas de controle (Fase B / DoD §3). Arquétipo A: props→render + evento + a11y.
import { fixture, html, expect, oneEvent } from '@open-wc/testing';
import './index.js';

describe('syn-icon (folha / arquétipo A)', () => {
  it('renderiza o SVG do nome', async () => {
    const el = await fixture(html`<syn-icon name="play"></syn-icon>`);
    expect(el.shadowRoot.querySelector('svg')).to.exist;
  });
  it('nome inexistente → sem SVG (sem quebrar)', async () => {
    const el = await fixture(html`<syn-icon name="zzz"></syn-icon>`);
    expect(el.shadowRoot.querySelector('svg')).to.not.exist;
  });
  it('com label vira ícone acessível (role=img)', async () => {
    const el = await fixture(html`<syn-icon name="play" label="Tocar"></syn-icon>`);
    const img = el.shadowRoot.querySelector('[role="img"]');
    expect(img).to.exist;
    expect(img.getAttribute('aria-label')).to.equal('Tocar');
  });
});

describe('syn-range (folha / arquétipo A)', () => {
  it('reflete value/min/max no input', async () => {
    const el = await fixture(html`<syn-range .value=${30} .min=${0} .max=${100}></syn-range>`);
    const input = el.shadowRoot.querySelector('input');
    expect(input.value).to.equal('30');
    expect(input.max).to.equal('100');
  });
  it('emite syn:control:change {value} ao mover', async () => {
    const el = await fixture(html`<syn-range .value=${10}></syn-range>`);
    const input = el.shadowRoot.querySelector('input');
    input.value = '42';
    setTimeout(() => input.dispatchEvent(new Event('input')));
    const e = await oneEvent(el, 'syn:control:change');
    expect(e.detail).to.deep.equal({ value: 42 });
    expect(e.composed).to.be.true;
  });
});

describe('syn-sync-badge (folha / arquétipo A)', () => {
  it('synced → ✓ + aria', async () => {
    const el = await fixture(html`<syn-sync-badge status="synced" label="Sincronizada"></syn-sync-badge>`);
    const b = el.shadowRoot.querySelector('.badge');
    expect(b.textContent.trim()).to.equal('✓');
    expect(b.getAttribute('aria-label')).to.equal('Sincronizada');
  });
  it('unsynced → ○', async () => {
    const el = await fixture(html`<syn-sync-badge status="unsynced"></syn-sync-badge>`);
    expect(el.shadowRoot.querySelector('.badge').textContent.trim()).to.equal('○');
  });
});

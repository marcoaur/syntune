// Teste do syn-device (DoD §3). Light-DOM: querySelector direto (sem shadowRoot).
import { fixture, html, expect, oneEvent } from '@open-wc/testing';
import './index.js';

const baseDev = { serial: 'X1', nickname: 'Pen', connected: true, free: 50, size: 100, syncEnabled: false, ignored: false };
const mk = (over = {}) => html`<syn-device .device=${{ ...baseDev, ...over }} .t=${(k) => k} .tn=${(k) => k} .artists=${[['ac/dc', 'AC/DC']]}></syn-device>`;

describe('syn-device (linha / Fase C)', () => {
  it('vira .device-row[data-serial] e mostra o apelido', async () => {
    const el = await fixture(mk());
    await el.updateComplete;
    expect(el.classList.contains('device-row')).to.be.true;
    expect(el.dataset.serial).to.equal('X1');
    expect(el.querySelector('.dv-nick').value).to.equal('Pen');
  });

  it('conectado renderiza a barra de capacidade', async () => {
    const el = await fixture(mk({ connected: true }));
    await el.updateComplete;
    expect(el.querySelector('.device-capacity .cap-bar')).to.exist;
  });

  it('ignorar emite syn:device:ignore (bubbles+composed)', async () => {
    const el = await fixture(mk());
    await el.updateComplete;
    setTimeout(() => el.querySelector('.dv-ignore').click());
    const e = await oneEvent(el, 'syn:device:ignore');
    expect(e.detail).to.deep.equal({ serial: 'X1', ignored: true });
    expect(e.composed).to.be.true;
  });

  it('sync ligado+conectado mostra "sincronizar agora" e emite sync-now', async () => {
    const el = await fixture(mk({ syncEnabled: true, connected: true }));
    await el.updateComplete;
    const btn = el.querySelector('.dv-sync-now');
    expect(btn).to.exist;
    setTimeout(() => btn.click());
    const e = await oneEvent(el, 'syn:device:sync-now');
    expect(e.detail.serial).to.equal('X1');
  });

  it('toggle de sync emite sync-toggle com enabled', async () => {
    const el = await fixture(mk({ syncEnabled: false }));
    await el.updateComplete;
    const chk = el.querySelector('.dv-sync input[type="checkbox"]');
    chk.checked = true;
    setTimeout(() => chk.dispatchEvent(new Event('change')));
    const e = await oneEvent(el, 'syn:device:sync-toggle');
    expect(e.detail.enabled).to.be.true;
    expect(e.detail.serial).to.equal('X1');
  });
});

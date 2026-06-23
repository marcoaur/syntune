// Teste do syn-song-card (DoD §3 — o core da Fase C). Light-DOM: querySelector direto.
import { fixture, html, expect, oneEvent } from '@open-wc/testing';
import './index.js';

const vm = (over = {}) => ({
  path: '/a.mp3', title: 'Faixa', sub: 'Artista · 2020', src: 'mp3cover:/a.mp3',
  coverKnown: undefined, deviceOnly: false, badge: null, ...over,
});

describe('syn-song-card (song / Fase C core)', () => {
  it('vira .song-card[data-path] e mostra título/sub', async () => {
    const el = await fixture(html`<syn-song-card .vm=${vm()} .t=${(k) => k}></syn-song-card>`);
    await el.updateComplete;
    expect(el.classList.contains('song-card')).to.be.true;
    expect(el.dataset.path).to.equal('/a.mp3');
    expect(el.querySelector('.song-title').textContent).to.equal('Faixa');
    expect(el.querySelector('.song-sub').textContent).to.equal('Artista · 2020');
  });

  it('coverKnown=false → placeholder, sem img', async () => {
    const el = await fixture(html`<syn-song-card .vm=${vm({ coverKnown: false })}></syn-song-card>`);
    await el.updateComplete;
    expect(el.querySelector('.song-thumb .ph')).to.exist;
    expect(el.querySelector('img')).to.not.exist;
  });

  it('badge sync → compõe syn-sync-badge', async () => {
    const el = await fixture(html`<syn-song-card .vm=${vm({ badge: { kind: 'sync', synced: true, label: 'ok' } })}></syn-song-card>`);
    await el.updateComplete;
    expect(el.querySelector('syn-sync-badge')).to.exist;
  });

  it('clicar no corpo emite syn:song:play', async () => {
    const el = await fixture(html`<syn-song-card .vm=${vm()}></syn-song-card>`);
    await el.updateComplete;
    setTimeout(() => el.querySelector('.song-info').click());
    const e = await oneEvent(el, 'syn:song:play');
    expect(e.detail.path).to.equal('/a.mp3');
  });

  it('clicar no ⋯ emite syn:song:menu (e não play)', async () => {
    const el = await fixture(html`<syn-song-card .vm=${vm()}></syn-song-card>`);
    await el.updateComplete;
    let played = false;
    el.addEventListener('syn:song:play', () => { played = true; });
    setTimeout(() => el.querySelector('.song-menu').click());
    const e = await oneEvent(el, 'syn:song:menu');
    expect(e.detail.path).to.equal('/a.mp3');
    expect(played).to.be.false;
  });
});

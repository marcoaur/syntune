// Teste do syn-mini-player (DoD §3). Consome um PlayerService mock (facade) por propriedade.
import { fixture, html, expect } from '@open-wc/testing';
import './index.js';

function mockPlayer(over = {}) {
  return {
    title: 'Faixa', artist: 'Artista', coverUrl: null, isPlaying: false,
    shuffle: false, repeatMode: 'off', volume: 1, currentTime: 0, duration: 0,
    onChange() { return () => {}; },
    calls: [],
    toggle() { this.calls.push('toggle'); }, next() { this.calls.push('next'); }, prev() { this.calls.push('prev'); },
    toggleShuffle() { this.calls.push('shuffle'); }, cycleRepeat() { this.calls.push('repeat'); },
    seekFraction() {}, seek() {}, setVolume() {}, openNowPlaying() { this.calls.push('np'); },
    toggleEq() {}, toggleQueue() {}, closePlayer() {},
    ...over,
  };
}

describe('syn-mini-player (Fase D)', () => {
  it('renderiza título/artista da facade', async () => {
    const el = await fixture(html`<syn-mini-player .player=${mockPlayer()} .t=${(k) => k}></syn-mini-player>`);
    await el.updateComplete;
    expect(el.querySelector('.player-title').textContent).to.equal('Faixa');
    expect(el.querySelector('.player-artist').textContent).to.equal('Artista');
  });

  it('ícone play/pause reflete isPlaying', async () => {
    const el = await fixture(html`<syn-mini-player .player=${mockPlayer({ isPlaying: true })} .t=${(k) => k}></syn-mini-player>`);
    await el.updateComplete;
    expect(el.querySelector('.pl-btn.play syn-icon').getAttribute('name')).to.equal('pause');
  });

  it('botões chamam o transporte da facade', async () => {
    const p = mockPlayer();
    const el = await fixture(html`<syn-mini-player .player=${p} .t=${(k) => k}></syn-mini-player>`);
    await el.updateComplete;
    el.querySelector('.pl-btn.play').click();
    el.querySelectorAll('.player-controls .pl-btn')[1].click(); // prev
    expect(p.calls).to.include('toggle');
    expect(p.calls).to.include('prev');
  });

  it('clicar na identidade abre o now-playing', async () => {
    const p = mockPlayer();
    const el = await fixture(html`<syn-mini-player .player=${p} .t=${(k) => k}></syn-mini-player>`);
    await el.updateComplete;
    el.querySelector('.player-id').click();
    expect(p.calls).to.include('np');
  });
});

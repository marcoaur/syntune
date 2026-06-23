// Teste do editor de letra (tap-time). Roda no browser via @web/test-runner. Foca o
// ciclo abrir→estrutura→editar→salvar (o rAF/foco/undo finos são gate de app).
import { fixture, html, expect, aTimeout } from '@open-wc/testing';
import './index.js';

function fakePlayer() {
  return { audio: { currentTime: 5, duration: 100, paused: true, playbackRate: 1, play() {}, pause() {} }, toggle() {} };
}
async function open(el, opts) {
  el.player = fakePlayer();
  el.open({ title: 'T', artist: 'A', lyrics: '', chords: '', ...opts });
  await el.updateComplete; await aTimeout(0); // open agenda o grid no updateComplete.then
}

describe('syn-lyrics-editor', () => {
  it('categoria lyric + vira modal (.le-modal)', async () => {
    const el = await fixture(html`<syn-lyrics-editor></syn-lyrics-editor>`);
    expect(el.constructor.category).to.equal('lyric');
    expect(el.classList.contains('le-modal')).to.be.true;
  });

  it('open monta 1 .le-row por linha do LRC + título/artista', async () => {
    const el = await fixture(html`<syn-lyrics-editor></syn-lyrics-editor>`);
    await open(el, { lyrics: '[00:01.00]um\n[00:02.00]dois\n[00:03.00]tres' });
    expect(el.querySelectorAll('.le-lines > .le-row').length).to.equal(3);
    expect(el.querySelector('.le-h-title').textContent).to.equal('T');
    expect(el.isOpen()).to.be.true;
  });

  it('salvar emite syn:lyrics-editor:save com o LRC serializado + fecha', async () => {
    const el = await fixture(html`<syn-lyrics-editor></syn-lyrics-editor>`);
    await open(el, { lyrics: '[00:01.00]um' });
    let saved = null;
    el.addEventListener('syn:lyrics-editor:save', (e) => { saved = e.detail; });
    el.querySelector('.le-save').click();
    expect(saved).to.exist;
    expect(saved.lyrics).to.contain('um');
    expect(el.isOpen()).to.be.false; // fecha após salvar
  });

  it('alternar modo letra↔acordes liga .chords-mode e troca o buffer', async () => {
    const el = await fixture(html`<syn-lyrics-editor></syn-lyrics-editor>`);
    await open(el, { lyrics: '[00:01.00]um', chords: '[00:01.00]G\n[00:02.00]D' });
    el.querySelector('.le-mode-btn').click();
    await el.updateComplete;
    expect(el.classList.contains('chords-mode')).to.be.true;
    expect(el.querySelectorAll('.le-lines > .le-row').length).to.equal(2); // buffer de acordes
  });

  it('botão + insere uma linha', async () => {
    const el = await fixture(html`<syn-lyrics-editor></syn-lyrics-editor>`);
    await open(el, { lyrics: '[00:01.00]um' });
    const before = el.querySelectorAll('.le-lines > .le-row').length;
    el.querySelector('.le-insert-btn').click();
    expect(el.querySelectorAll('.le-lines > .le-row').length).to.equal(before + 1);
  });
});

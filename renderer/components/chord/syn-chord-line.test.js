// Teste da ilha de acordes (DoD §3 — props→render + eventos). Roda no browser via
// @web/test-runner (`npm run test:wc`). Cobre os arquétipos A (folha) e B (container):
// não depende de PlayerService real — valida render idempotente e o feedback up.
import { fixture, html, expect, oneEvent } from '@open-wc/testing';
import './index.js';

describe('syn-chord-mark (folha / arquétipo A)', () => {
  it('renderiza o label e é acessível (button + aria-label)', async () => {
    const el = await fixture(html`<syn-chord-mark label="Am7" .time=${3.5}></syn-chord-mark>`);
    const btn = el.shadowRoot.querySelector('button');
    expect(btn).to.exist;
    expect(btn.textContent).to.equal('Am7');
    expect(btn.getAttribute('aria-label')).to.contain('Am7');
  });

  it('emite syn:chord:select (bubbles+composed) ao clicar', async () => {
    const el = await fixture(html`<syn-chord-mark label="C" .time=${1}></syn-chord-mark>`);
    setTimeout(() => el.shadowRoot.querySelector('button').click());
    const e = await oneEvent(el, 'syn:chord:select');
    expect(e.detail).to.deep.equal({ time: 1, label: 'C' });
    expect(e.composed).to.be.true;
  });
});

describe('syn-chord-line (container / arquétipo B)', () => {
  const chords = [{ time: 1, label: 'G' }, { time: 4, label: 'D' }, { time: 7, label: 'Em' }];

  it('monta um syn-chord-mark por acorde (props down)', async () => {
    const el = await fixture(html`<syn-chord-line .chords=${chords} .start=${0} .end=${12}></syn-chord-line>`);
    await el.updateComplete;
    const marks = el.shadowRoot.querySelectorAll('syn-chord-mark');
    expect(marks.length).to.equal(3);
    expect(marks[0].label).to.equal('G');
  });

  it('é idempotente: mesmas props → mesmo nº de marks', async () => {
    const el = await fixture(html`<syn-chord-line .chords=${chords} .start=${0} .end=${12}></syn-chord-line>`);
    await el.updateComplete;
    el.chords = chords.slice();
    await el.updateComplete;
    expect(el.shadowRoot.querySelectorAll('syn-chord-mark').length).to.equal(3);
  });

  it('relê e re-emite o feedback do filho como syn:chordline:select (events up)', async () => {
    const el = await fixture(html`<syn-chord-line .chords=${chords} .start=${0} .end=${12}></syn-chord-line>`);
    await el.updateComplete;
    const mark = el.shadowRoot.querySelector('syn-chord-mark');
    await mark.updateComplete;
    setTimeout(() => mark.shadowRoot.querySelector('button').click());
    const e = await oneEvent(el, 'syn:chordline:select');
    expect(e.detail.label).to.equal('G');
  });

  it('tem papel de grupo (a11y)', async () => {
    const el = await fixture(html`<syn-chord-line .chords=${chords}></syn-chord-line>`);
    expect(el.getAttribute('role')).to.equal('group');
  });
});

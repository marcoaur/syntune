// Teste do syn-queue-item (DoD §3). Light-DOM: querySelector direto.
import { fixture, html, expect, oneEvent } from '@open-wc/testing';
import './index.js';

const vm = (over = {}) => ({ path: '/q.mp3', title: 'Q', artist: 'Art', src: 'mp3cover:/q.mp3', coverKnown: undefined, current: false, ...over });

describe('syn-queue-item (fila / Fase D)', () => {
  it('vira .queue-item e mostra título/artista', async () => {
    const el = await fixture(html`<syn-queue-item .vm=${vm()} .t=${(k) => k}></syn-queue-item>`);
    await el.updateComplete;
    expect(el.classList.contains('queue-item')).to.be.true;
    expect(el.querySelector('.qi-title').textContent).to.equal('Q');
    expect(el.querySelector('.qi-artist').textContent).to.equal('Art');
  });

  it('faixa atual: classe current + sem botão remover', async () => {
    const el = await fixture(html`<syn-queue-item .vm=${vm({ current: true })} .t=${(k) => k}></syn-queue-item>`);
    await el.updateComplete;
    expect(el.classList.contains('current')).to.be.true;
    expect(el.querySelector('.qi-remove')).to.not.exist;
  });

  it('clicar no corpo emite syn:queue:jump', async () => {
    const el = await fixture(html`<syn-queue-item .vm=${vm()} .t=${(k) => k}></syn-queue-item>`);
    await el.updateComplete;
    setTimeout(() => el.querySelector('.qi-text').click());
    const e = await oneEvent(el, 'syn:queue:jump');
    expect(e.detail.path).to.equal('/q.mp3');
  });

  it('remover emite syn:queue:remove (e não jump)', async () => {
    const el = await fixture(html`<syn-queue-item .vm=${vm()} .t=${(k) => k}></syn-queue-item>`);
    await el.updateComplete;
    let jumped = false;
    el.addEventListener('syn:queue:jump', () => { jumped = true; });
    setTimeout(() => el.querySelector('.qi-remove').click());
    const e = await oneEvent(el, 'syn:queue:remove');
    expect(e.detail.path).to.equal('/q.mp3');
    expect(jumped).to.be.false;
  });

  it('coverKnown=false → placeholder, sem img', async () => {
    const el = await fixture(html`<syn-queue-item .vm=${vm({ coverKnown: false })} .t=${(k) => k}></syn-queue-item>`);
    await el.updateComplete;
    expect(el.querySelector('img')).to.not.exist;
    expect(el.querySelector('.qi-thumb').textContent.trim()).to.equal('♪');
  });
});

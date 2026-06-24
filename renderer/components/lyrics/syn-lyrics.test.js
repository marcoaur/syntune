// Teste do karaokê (DoD §3 — props→render + estrutura). Roda no browser via
// @web/test-runner (`npm run test:wc`). Foca o MODELO/estrutura (motor de scroll/rAF é
// hot-path imperativo, validado no app): linhas certas, embute syn-chord-line por verso
// com acordes, intro/interlúdio, instrumental e os casos texto-puro/vazio.
import { fixture, html, expect } from '@open-wc/testing';
import './index.js';

// 1ª linha em t=1 (< 3s) → SEM interlúdio de intro, isola a contagem de versos.
const lines = [
  { t: 1, text: 'primeira linha' },
  { t: 9, text: 'segunda linha' },
  { t: 13, text: 'terceira linha' },
];
const chords = [
  { t: 6, text: 'G' }, { t: 10, text: 'D' }, { t: 14, text: 'Em' },
];

describe('syn-lyrics (karaokê / container conectado)', () => {
  it('categoria lyric + a11y role=list', async () => {
    const el = await fixture(html`<syn-lyrics></syn-lyrics>`);
    expect(el.constructor.category).to.equal('lyric');
    expect(el.getAttribute('role')).to.equal('list');
  });

  it('letra sincronizada: 1 .np-lyric por verso, sem acordes quando showChords=false', async () => {
    const el = await fixture(html`<syn-lyrics .synced=${lines} .chordsData=${chords}></syn-lyrics>`);
    await el.updateComplete;
    const ls = el.querySelectorAll('.np-lyrics-track > .np-lyric');
    expect(ls.length).to.equal(3);
    expect(el.querySelectorAll('syn-chord-line').length).to.equal(0);
  });

  it('com showChords: embute syn-chord-line nos versos com acordes (janela por verso)', async () => {
    const el = await fixture(html`<syn-lyrics .synced=${lines} .chordsData=${chords} .showChords=${true}></syn-lyrics>`);
    await el.updateComplete;
    const cls = el.querySelectorAll('syn-chord-line');
    expect(cls.length).to.equal(3); // 1 acorde por verso → 3 linhas de acorde
    // janela do 1º verso = [verso.t, próximo.t]
    expect(cls[0].start).to.equal(1);
    expect(cls[0].end).to.equal(9);
    expect(el.querySelectorAll('.np-lyric.has-chords').length).to.equal(3);
  });

  it('intro instrumental: acorde antes da 1ª linha vira linha .np-chord-only própria', async () => {
    const late = [{ t: 5, text: 'verso' }, { t: 9, text: 'verso 2' }];
    const intro = [{ t: 1, text: 'C' }, { t: 6, text: 'G' }];
    const el = await fixture(html`<syn-lyrics .synced=${late} .chordsData=${intro} .showChords=${true}></syn-lyrics>`);
    await el.updateComplete;
    const only = el.querySelectorAll('.np-lyric.np-chord-only');
    expect(only.length).to.equal(1);
  });

  it('gap > 3s sem acordes: mostra interlúdio de 3 pontos', async () => {
    const late = [{ t: 5, text: 'verso' }, { t: 9, text: 'verso 2' }];
    const el = await fixture(html`<syn-lyrics .synced=${late}></syn-lyrics>`);
    await el.updateComplete;
    const inter = el.querySelector('.np-interlude');
    expect(inter).to.exist;
    expect(inter.querySelectorAll('i').length).to.equal(3);
  });

  it('instrumental (sem letra, só acordes): agrupa em linhas .np-chord-only', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ t: i * 2, text: 'A' }));
    const el = await fixture(html`<syn-lyrics .chordsData=${many} .showChords=${true}></syn-lyrics>`);
    await el.updateComplete;
    expect(el.querySelectorAll('.np-lyric.np-chord-only').length).to.equal(2); // 6 acordes / grupos de 4
  });

  it('texto puro (sem sincronia): bloco .np-lyrics-empty pre-wrap', async () => {
    const el = await fixture(html`<syn-lyrics .plain=${'linha um\nlinha dois'}></syn-lyrics>`);
    await el.updateComplete;
    const box = el.querySelector('.np-lyrics-empty');
    expect(box).to.exist;
    expect(box.textContent).to.contain('linha um');
  });

  it('vazio: usa t(player.noLyrics)', async () => {
    const el = await fixture(html`<syn-lyrics .t=${() => 'sem letra'}></syn-lyrics>`);
    await el.updateComplete;
    expect(el.querySelector('.np-lyrics-empty').textContent).to.contain('sem letra');
  });

  it('clique no verso emite seek via player (intent)', async () => {
    let sought = null;
    const el = await fixture(html`<syn-lyrics .synced=${lines}></syn-lyrics>`);
    // injeta um player fake no lugar do consumer (sem app-root no teste)
    el._player = { value: { seek: (t) => { sought = t; } } };
    await el.updateComplete;
    el.querySelectorAll('.np-lyrics-track > .np-lyric')[1].click();
    expect(sought).to.be.closeTo(9.02, 0.001);
  });
});

describe('syn-lyrics — editor inline (advancedEdit)', () => {
  async function mount(chordsArr) {
    const el = await fixture(html`<syn-lyrics .synced=${lines} .chordsData=${chordsArr}
      .showChords=${true} .editMode=${true}></syn-lyrics>`);
    await el.updateComplete;
    return el;
  }

  it('editMode: todo verso ganha syn-chord-line (gutter) e fica editável', async () => {
    const el = await mount([{ t: 6, text: 'G' }]);
    const cls = el.querySelectorAll('syn-chord-line');
    expect(cls.length).to.equal(3);          // gutter em todos os versos
    expect(cls[0].editable).to.be.true;
  });

  it('Delete no acorde selecionado remove do estado + emite syn:chords:change', async () => {
    const arr = [{ t: 6, text: 'G' }];
    const el = await mount(arr);
    const line = el.querySelector('syn-chord-line'); await line.updateComplete;
    const mark = line.shadowRoot.querySelector('syn-chord-mark'); await mark.updateComplete;
    let changed = 0; el.addEventListener('syn:chords:change', () => changed++);
    // seleciona via pointerdown real (composedPath inclui mark + line)
    mark.shadowRoot.querySelector('button').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    expect(el._sel).to.equal(mark);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
    expect(arr.length).to.equal(0);
    expect(changed).to.be.greaterThan(0);
  });

  it('renomear (syn:chord:edit → input → Enter) muta o texto + marca sujo', async () => {
    const arr = [{ t: 6, text: 'G' }];
    const el = await mount(arr);
    const line = el.querySelector('syn-chord-line'); await line.updateComplete;
    const mark = line.shadowRoot.querySelector('syn-chord-mark'); await mark.updateComplete;
    let changed = 0; el.addEventListener('syn:chords:change', () => changed++);
    mark.dispatchEvent(new CustomEvent('syn:chord:edit', { bubbles: true, composed: true }));
    const inp = document.querySelector('input.np-chord-input');
    expect(inp).to.exist;
    inp.value = 'Am';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(arr[0].text).to.equal('Am');
    expect(changed).to.be.greaterThan(0);
  });

  it('ArrowRight no selecionado empurra o tempo (10ms) + emite change', async () => {
    const arr = [{ t: 6, text: 'G' }];
    const el = await mount(arr);
    const line = el.querySelector('syn-chord-line'); await line.updateComplete;
    const mark = line.shadowRoot.querySelector('syn-chord-mark'); await mark.updateComplete;
    let changed = 0; el.addEventListener('syn:chords:change', () => changed++);
    mark.shadowRoot.querySelector('button').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(arr[0].t).to.be.closeTo(6.01, 0.0001);
    expect(changed).to.be.greaterThan(0);
  });
});

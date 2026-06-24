// Teste da ilha do editor de detalhes (Fase E). A ilha é render-once e estrutural:
// preserva os IDs que a cola do renderer dirige e expõe abrir/fechar o drawer de edição.
// O comportamento pesado (readTags/saveTags/capa/IA/letra) é gate de app no renderer.
import { fixture, html, expect } from '@open-wc/testing';
import './index.js';

// IDs que a cola do renderer (openEditor/renderEditorView/saveDetails/capa/letra) consome.
const GLUE_IDS = [
  'editorBack', 'fileName', 'deleteBtn', 'editToggle', 'editDone',
  'editorView', 'evCover', 'evTitle', 'evArtist', 'evAlbum', 'evPlay',
  'evLastfmStats', 'evGlobalPlays', 'evGlobalType', 'evTagsCard', 'evGlobalTags', 'evMeta',
  'evLyricsWrap', 'lyricsStatusBtn', 'lscTitle', 'lscSub', 'evLyricsBadge', 'evLyrics',
  'editorEdit', 'coverPreview', 'selectImageBtn', 'adjustCoverBtn', 'removeImageBtn',
  'hint', 'fetchBtn', 'aiStatus',
  'title', 'artist', 'album', 'albumArtist', 'composer', 'year', 'genre',
  'trackNumber', 'partOfSet', 'publisher', 'comment', 'lyrics', 'chords',
];

describe('syn-track-editor', () => {
  it('categoria track + light-DOM display:contents', async () => {
    const el = await fixture(html`<syn-track-editor></syn-track-editor>`);
    expect(el.constructor.category).to.equal('track');
    expect(el.createRenderRoot()).to.equal(el);       // light-DOM
    expect(el.style.display).to.equal('contents');
  });

  it('preserva TODOS os IDs que a cola do renderer dirige', async () => {
    const el = await fixture(html`<syn-track-editor></syn-track-editor>`);
    for (const id of GLUE_IDS) {
      expect(el.querySelector('#' + id), `falta #${id}`).to.exist;
    }
  });

  it('campos de metadata são os 12 esperados (fields do renderer)', async () => {
    const el = await fixture(html`<syn-track-editor></syn-track-editor>`);
    // 11 inputs + comment textarea, dentro do #editorEdit (drawer)
    const drawer = el.querySelector('#editorEdit');
    ['title', 'artist', 'album', 'albumArtist', 'composer', 'year', 'genre',
     'trackNumber', 'partOfSet', 'publisher'].forEach((id) => {
      expect(drawer.querySelector('input#' + id), id).to.exist;
    });
    expect(drawer.querySelector('textarea#comment')).to.exist;
    // letra/acordes ficam hidden (a cola lê/escreve)
    expect(drawer.querySelector('textarea#lyrics').classList.contains('hidden')).to.be.true;
    expect(drawer.querySelector('textarea#chords').classList.contains('hidden')).to.be.true;
  });

  it('painel de letra = carro-chefe: CTA + teaser + fade', async () => {
    const el = await fixture(html`<syn-track-editor></syn-track-editor>`);
    const panel = el.querySelector('#evLyricsWrap');
    expect(panel.classList.contains('te-lyrics-panel')).to.be.true;
    expect(panel.querySelector('.te-lyrics-cta#lyricsStatusBtn')).to.exist;
    expect(panel.querySelector('.te-lyrics-teaser#evLyrics')).to.exist;
    expect(panel.querySelector('.te-lyrics-fade')).to.exist;
  });

  it('openDrawer/closeDrawer alternam view-mode↔edit-mode na .editor pai', async () => {
    const wrap = await fixture(html`
      <section class="editor view-mode"><syn-track-editor></syn-track-editor></section>`);
    const el = wrap.querySelector('syn-track-editor');
    el.openDrawer();
    expect(wrap.classList.contains('edit-mode')).to.be.true;
    expect(wrap.classList.contains('view-mode')).to.be.false;
    el.closeDrawer();
    expect(wrap.classList.contains('view-mode')).to.be.true;
    expect(wrap.classList.contains('edit-mode')).to.be.false;
  });
});

// <syn-track-editor> — editor imersivo de detalhes da faixa (FRONTEND-MIGRATION.md Fase E,
// última ilha). REDESIGN, não port: repensa a tela de detalhes em torno do carro-chefe do
// produto — a LETRA. Layout novo: hero da capa, stats Last.fm, painel de Letra com fade no
// rodapé (impressão de continuidade) e a edição de metadata como DRAWER sobreposto.
//
// Arquitetura (tática leaf-migration levada ao hub): LIGHT-DOM com `display:contents`, montado
// DENTRO de `#editor` (substitui o markup legado). Renderiza a shell UMA vez (nenhum estado
// reativo muta os nós que a cola do renderer dirige) e PRESERVA os IDs que o renderer.js já
// usa (evTitle/title/coverPreview/lyricsStatusBtn/…) — então TODA a cola pesada (readTags,
// saveTags, pipeline de capa, IA enrich, ações de letra) continua valendo sem reescrita; o
// renderer só re-liga os listeners pós-montagem (`bindEditorEvents`). As interações NOVAS do
// redesign (abrir/fechar o drawer de edição) são donas da ilha, via classList no `#editor`.
//
// Coexiste com o markup legado de `index.html#editor`: sob `electron .` (sem bundler) a ilha
// não é definida → legado intacto; sob electron-vite a ilha substitui o interior.
import { html } from 'lit';
import { SyntuneElement } from '../base/syntune-element.js';

// Ícones inline (mesmo traço do resto do editor) — back/edit/save/delete/play.
const I_BACK   = html`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>`;
const I_DELETE = html`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
const I_EDIT   = html`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
const I_SAVE   = html`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
const I_PLAY   = html`<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
const I_CHEVRON = html`<svg class="lsc-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`;

// Campos de metadata na ordem do form (espelha `fields` do renderer).
const FORM_FIELDS = [
  { id: 'title',       i18n: 'fields.title',       span: 2 },
  { id: 'artist',      i18n: 'fields.artist' },
  { id: 'album',       i18n: 'fields.album' },
  { id: 'albumArtist', i18n: 'fields.albumArtist' },
  { id: 'composer',    i18n: 'fields.composer' },
  { id: 'year',        i18n: 'fields.year',        attrs: { maxlength: '4' } },
  { id: 'genre',       i18n: 'fields.genre' },
  { id: 'trackNumber', i18n: 'fields.trackNumber' },
  { id: 'partOfSet',   i18n: 'fields.partOfSet' },
  { id: 'publisher',   i18n: 'fields.publisher',   span: 2 },
];

export class SynTrackEditor extends SyntuneElement {
  static category = 'track';
  createRenderRoot() { return this; }   // light-DOM: reusa a CSS global do editor

  constructor() {
    super();
    this.t = (k) => k;   // injetado pelo renderer (i18n)
  }

  // tradução com fallback (antes do renderer injetar `t`, mostra a chave)
  #t(k, p) { try { return this.t(k, p); } catch { return k; } }

  connectedCallback() {
    super.connectedCallback();
    this.style.display = 'contents';   // a ilha some do layout; filhos viram filhos de #editor
  }

  // ---- abre/fecha o drawer de edição (interação NOVA, dona da ilha) ----
  // O renderer ainda alterna view-mode/edit-mode na #editor; aqui só animamos o drawer.
  get #section() { return this.closest('.editor'); }
  openDrawer()  { const s = this.#section; if (s) { s.classList.remove('view-mode'); s.classList.add('edit-mode'); } }
  closeDrawer() { const s = this.#section; if (s) { s.classList.remove('edit-mode'); s.classList.add('view-mode'); } }

  render() {
    const t = (k, p) => this.#t(k, p);
    return html`
      <div class="ed-ambient"></div>

      <div class="editor-head">
        <button id="editorBack" class="ed-btn" title=${t('common.back')}>${I_BACK}</button>
        <span id="fileName" class="ed-filename">arquivo.mp3</span>
        <div class="ed-head-actions">
          <button id="deleteBtn" class="ed-btn ed-done ed-delete-btn" title=${t('common.delete')}>${I_DELETE}</button>
          <button id="editToggle" class="ed-btn ed-edit-toggle" title=${t('editor.editDetails')}>${I_EDIT}</button>
          <button id="editDone" class="ed-btn ed-btn-save ed-done" title=${t('editor.done')}>${I_SAVE}</button>
        </div>
      </div>

      <div class="editor-scroll">
        <!-- ===== VIEW imersiva (somente leitura) ===== -->
        <div id="editorView" class="editor-view te-view">
          <div class="ev-hero te-hero">
            <div id="evCover" class="ev-cover te-cover"><span class="ph">♪</span></div>
            <div class="ev-headline te-headline">
              <div id="evTitle" class="ev-title">—</div>
              <div id="evArtist" class="ev-artist"></div>
              <div id="evAlbum" class="ev-album"></div>
              <button id="evPlay" class="ev-play">${I_PLAY}<span>${t('common.play')}</span></button>
            </div>
          </div>

          <!-- ===== Letra = CARRO-CHEFE: painel com header + teaser + fade no rodapé ===== -->
          <div id="evLyricsWrap" class="ev-lyrics te-lyrics-panel hidden">
            <button id="lyricsStatusBtn" type="button" class="lyrics-status-card te-lyrics-cta">
              <span id="lscIcon" class="lsc-icon" aria-hidden="true"></span>
              <div class="lsc-info">
                <span id="lscTitle" class="lsc-title">${t('lyrics.status.pending.title')}</span>
                <span id="lscSub" class="lsc-sub">${t('lyrics.modal.loading')}</span>
              </div>
              <span id="evLyricsBadge" class="ev-lyrics-badge ev-lyrics-badge--pending hidden"></span>
              ${I_CHEVRON}
            </button>
            <div class="te-lyrics-body">
              <div id="evLyrics" class="ev-lyrics-text te-lyrics-teaser"></div>
              <div class="te-lyrics-fade" aria-hidden="true"></div>
            </div>
          </div>

          <div id="evLastfmStats" class="ev-lastfm-stats hidden">
            <div class="ev-stats-group">
              <div class="ev-stat-card" title=${t('stats.globalPlaysTitle')}>
                <span class="ev-stat-icon">🌍</span>
                <div class="ev-stat-content">
                  <span class="ev-stat-label">${t('stats.globalPlays')}</span>
                  <span id="evGlobalPlays" class="ev-stat-value">—</span>
                </div>
              </div>
              <div id="evTypeCard" class="ev-stat-card" title=${t('stats.profileTitle')}>
                <span id="evTypeIcon" class="ev-stat-icon">🔥</span>
                <div class="ev-stat-content">
                  <span class="ev-stat-label">${t('stats.profile')}</span>
                  <span id="evGlobalType" class="ev-stat-value">—</span>
                </div>
              </div>
            </div>
            <div id="evTagsCard" class="ev-stat-card hidden" title=${t('stats.tagsTitle')} style="margin-top: 12px; align-items: flex-start;">
              <span class="ev-stat-icon" style="margin-top: 2px;">🏷️</span>
              <div class="ev-stat-content" style="flex: 1;">
                <span class="ev-stat-label">${t('stats.moodGenre')}</span>
                <div id="evGlobalTags" class="ev-tags-list"></div>
              </div>
            </div>
          </div>

          <div id="evMeta" class="ev-meta"></div>
        </div>

        <!-- ===== EDIT = drawer sobreposto (metadata + capa + IA) ===== -->
        <div id="editorEdit" class="editor-edit te-drawer">
          <div class="editor-body">
            <div class="top-row">
              <div class="cover-col">
                <div id="coverPreview" class="cover-preview" tabindex="0" title=${t('editor.coverPasteTitle')}>
                  <span class="cover-placeholder">${t('editor.noCoverPh')}</span>
                </div>
                <button id="selectImageBtn" class="btn btn-secondary full btn-sm">${t('editor.chooseCover')}</button>
                <button id="adjustCoverBtn" class="btn btn-secondary full btn-sm hidden">${t('editor.adjust')}</button>
                <button id="removeImageBtn" class="btn btn-ghost full btn-sm hidden">${t('editor.remove')}</button>
              </div>
              <div class="ai-col">
                <div class="ai-row">
                  <input id="hint" type="text" class="input" placeholder=${t('editor.hintPlaceholder')} />
                  <button id="fetchBtn" class="btn btn-primary btn-sm">${t('editor.fetch')}</button>
                </div>
                <div id="aiStatus" class="ai-status hidden"></div>
              </div>
            </div>

            <div class="form-grid">
              ${FORM_FIELDS.map((f) => html`
                <label class="field ${f.span === 2 ? 'span-2' : ''}">
                  <span>${t(f.i18n)}</span>
                  <input id=${f.id} type="text" class="input"
                    maxlength=${f.attrs && f.attrs.maxlength ? f.attrs.maxlength : ''} />
                </label>`)}
              <label class="field span-2">
                <span>${t('fields.comment')}</span>
                <textarea id="comment" class="input" rows="2"></textarea>
              </label>
              <!-- letra/acordes ficam em hidden: a cola lê/escreve; edição real é pelo carro-chefe -->
              <textarea id="lyrics" class="hidden"></textarea>
              <textarea id="chords" class="hidden"></textarea>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define('syn-track-editor', SynTrackEditor);

// <syn-lyrics-editor> — editor de letra com tap-time (FRONTEND-MIGRATION.md Fase E).
// Modal autocontido: grid de linhas {time,text}, modos letra/acordes, undo/redo, rAF de
// linha-ativa, ticks de progresso, velocidade, menu de ferramentas. LIGHT-DOM reusando a
// CSS global `.le-*` (peça muito acoplada à styles.css — tática leaf-migration).
//
// A shell (header/progress/grid) é renderizada UMA vez pelo Lit; as linhas são construídas
// IMPERATIVAMENTE em `.le-grid` (foco/cursor/undo idênticos ao legado — Lit não re-renderiza
// e apaga, pois nenhum estado reativo muda em uso). Classes internas (sem IDs) p/ não colidir
// com o modal legado. Persistência fica no renderer: emite `syn:lyrics-editor:save`
// {lyrics, chords} e `syn:lyrics-editor:close`; o renderer grava as tags e restaura o player.
import { html, css } from 'lit';
import { SyntuneElement } from '../base/syntune-element.js';
import { fmtTimestamp, parseLrcTime, parseLrcSeconds, parseLyricsToLines, serializeLines } from '../../modules/lrc.js';

const LE_RATES = [1, 0.75, 0.5];
const ICON_CLEF = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M13.1 2c-1.7 0-2.9 1.5-2.9 3.4 0 1 .2 2 .5 3.1-2 1.6-3.2 3.4-3.2 5.6 0 2.6 1.9 4.6 4.5 4.6.4 0 .8 0 1.2-.1l.3 2.1c.2 1.4-.5 2.2-1.6 2.2-.8 0-1.4-.4-1.6-1 .6-.1 1-.6 1-1.2 0-.7-.6-1.3-1.3-1.3-.8 0-1.4.6-1.4 1.5 0 1.5 1.3 2.6 3.2 2.6 1.9 0 3.2-1.3 2.9-3.3l-.3-2.2c1.6-.6 2.6-2 2.6-3.6 0-1.8-1.3-3.2-3.1-3.2-.3 0-.5 0-.8.1l-.4-2.6c1.1-1.1 1.8-2.3 1.8-3.8C14.9 3.2 14.1 2 13.1 2zm-.2 1.3c.5 0 .8.6.8 1.4 0 .9-.4 1.8-1.1 2.6-.2-.8-.4-1.6-.4-2.3 0-1 .3-1.7.7-1.7zm.6 7.8c1.1 0 1.9.9 1.9 2.1 0 1-.6 1.9-1.6 2.3l-.6-4.3c.1 0 .2-.1.3-.1zm-1.5.4l.6 4.4c-.2 0-.5.1-.7.1-1.8 0-3.1-1.4-3.1-3.2 0-1.4.8-2.6 2.1-3.6.2.8.6 1.5 1 2.3z"/></svg>';
const ICON_MIC = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';
const ICON_DEL_X = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
const ICON_GRIP = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';

export class SynLyricsEditor extends SyntuneElement {
  static category = 'lyric';
  static styles = [css``];
  createRenderRoot() { return this; }

  constructor() {
    super();
    this.t = (k) => k;
    this.player = null;       // facade (usa .audio p/ tempo/transporte)
    // estado do editor (espelha as globais le* do renderer):
    this._lines = [];
    this._mode = 'lyrics';
    this._buf = { lyrics: [], chords: [] };
    this._focusIdx = 0;
    this._lastActiveIdx = -1;
    this._dragFrom = null;
    this._dirty = false;
    this._ticksDirty = true;
    this._ticksDur = 0;
    this._undo = [];
    this._redo = [];
    this._coalesce = null;
    this._raf = null;
    this._rate = 1;
    this._onDocKey = (e) => this.#onKey(e);
    this._onDocClick = () => { if (this.#menuOpen()) this.#menuClose(); };
  }

  get _audio() { return this.player && this.player.audio; }
  #snap(s) { return JSON.parse(JSON.stringify(s)); }
  #$(sel) { return this.querySelector(sel); }

  connectedCallback() {
    super.connectedCallback();
    this.classList.add('le-modal');
    this.setAttribute('role', 'dialog');
    this.setAttribute('aria-modal', 'true');
    document.addEventListener('keydown', this._onDocKey);
    document.addEventListener('click', this._onDocClick);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this._onDocKey);
    document.removeEventListener('click', this._onDocClick);
    this.#stopLoop();
  }

  // ---------- shell (renderizada uma vez) ----------
  render() {
    const t = this.t;
    return html`
      <div class="le-ambient"></div>
      <header class="le-header">
        <button class="le-icon-btn le-back" type="button" title=${t('common.back')}
          @click=${() => this.#tryClose()}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <div class="le-header-info">
          <div class="le-h-title"></div>
          <div class="le-h-artist"></div>
        </div>
        <div class="le-header-actions">
          <button class="le-icon-btn le-mode-btn" type="button" @click=${() => this.#switchMode()}></button>
          <button class="le-icon-btn le-speed-btn" type="button" title=${t('lyrics.editor.speed')}
            @click=${() => this.#cycleSpeed()}>1x</button>
          <div class="le-menu-wrap">
            <button class="le-icon-btn le-menu-btn" type="button" title=${t('lyrics.editor.tools')}
              aria-haspopup="true" aria-expanded="false"
              @click=${(e) => { e.stopPropagation(); this.#menuOpen() ? this.#menuClose() : this.#menuShow(); }}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
            </button>
            <div class="le-menu hidden" role="menu" @click=${(e) => e.stopPropagation()}>
              <div class="le-menu-label">${t('lyrics.editor.shiftAll')}</div>
              <div class="le-menu-shift">
                <button class="le-tool-btn" type="button" @click=${() => this.#offsetAll(-0.1)}>−100ms</button>
                <button class="le-tool-btn" type="button" @click=${() => this.#offsetAll(0.1)}>+100ms</button>
              </div>
              <button class="le-menu-item le-menu-item--danger le-clear-times" type="button" role="menuitem"
                @click=${() => { this.#clearTimes(); this.#menuClose(); }}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
                <span>${t('lyrics.editor.clearTimes')}</span>
              </button>
              <div class="le-menu-sep"></div>
              <div class="le-menu-info"><strong class="le-line-count">0</strong> ${t('lyrics.editor.linesLabel')}</div>
            </div>
          </div>
          <button class="le-btn le-btn-ghost le-discard" @click=${() => this.#tryClose()}>${t('common.discard')}</button>
          <button class="le-btn le-btn-primary le-save" @click=${() => this.#save()}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
            <span>${t('lyrics.editor.save')}</span>
          </button>
        </div>
      </header>
      <div class="le-progress" title=${t('lyrics.editor.seekHint')} @click=${(e) => this.#seekProgress(e)}>
        <div class="le-progress-ticks"></div>
        <div class="le-progress-fill"></div>
        <div class="le-progress-head"></div>
      </div>
      <div class="le-content">
        <div class="le-grid-header">
          <span class="le-col-time-h">${t('lyrics.editor.colTime')}</span>
          <span class="le-col-text-h">${t('lyrics.editor.colText')}</span>
        </div>
        <div class="le-grid le-lines"></div>
      </div>
    `;
  }

  // ---------- abrir / fechar ----------
  // Chamado pelo renderer com os dados atuais. Elevação do player + tocar a faixa ficam
  // no renderer (acoplados ao estado da app).
  open({ title, artist, lyrics, chords, accent }) {
    if (accent) this.style.setProperty('--cv', accent); // cor da capa (ambiente + realces)
    this._buf.lyrics = parseLyricsToLines((lyrics || '').trim());
    this._buf.chords = parseLyricsToLines((chords || '').trim());
    this._mode = 'lyrics';
    this._lines = this._buf.lyrics;
    this._focusIdx = 0; this._lastActiveIdx = -1;
    this._undo = []; this._redo = [];
    if (this._coalesce) { clearTimeout(this._coalesce); this._coalesce = null; }
    this._dirty = false;
    this._rate = 1; if (this._audio) this._audio.playbackRate = 1;
    this.classList.remove('hidden');
    this.updateComplete.then(() => {
      const ti = this.#$('.le-h-title'); if (ti) ti.textContent = (title || '').trim() || '—';
      const ar = this.#$('.le-h-artist'); if (ar) ar.textContent = (artist || '').trim() || '—';
      this.#updateSpeedBtn();
      this.#applyMode();
      this.#renderAllLines();
      requestAnimationFrame(() => { const f = this.#$('.le-text'); if (f) f.focus(); });
      this.#startLoop();
    });
  }

  isOpen() { return !this.classList.contains('hidden'); }

  close() {
    this.classList.add('hidden');
    this.#menuClose();
    this.#stopLoop();
    this._rate = 1; if (this._audio) this._audio.playbackRate = 1;
    this.emit('syn:lyrics-editor:close', {});
  }

  #tryClose() {
    if (this._dirty && !confirm(this.t('lyrics.confirm.discard'))) return;
    this.close();
  }

  // ---------- undo / redo ----------
  #record() {
    this._dirty = true;
    if (this._coalesce) { clearTimeout(this._coalesce); }
    else { this._undo.push(this.#snap(this._lines)); if (this._undo.length > 200) this._undo.shift(); this._redo = []; }
    this._coalesce = setTimeout(() => { this._coalesce = null; }, 400);
  }
  #undoAction() {
    if (!this._undo.length) return;
    if (this._coalesce) { clearTimeout(this._coalesce); this._coalesce = null; }
    this._redo.push(this.#snap(this._lines));
    this._lines = this._undo.pop();
    this.#renderAllLines();
  }
  #redoAction() {
    if (!this._redo.length) return;
    this._undo.push(this.#snap(this._lines));
    this._lines = this._redo.pop();
    this.#renderAllLines();
  }

  // ---------- velocidade ----------
  #updateSpeedBtn() { const b = this.#$('.le-speed-btn'); if (b) b.textContent = (this._rate === 1 ? '1' : String(this._rate).replace('0.', '.')) + 'x'; }
  #cycleSpeed() {
    const i = LE_RATES.indexOf(this._rate);
    this._rate = LE_RATES[(i + 1) % LE_RATES.length];
    if (this._audio) this._audio.playbackRate = this._rate;
    this.#updateSpeedBtn();
  }

  // ---------- ferramentas de tempo ----------
  #offsetAll(delta) {
    if (!this._lines.some((l) => l.time)) return;
    this.#record();
    this._lines.forEach((l) => { const s = parseLrcSeconds(l.time); if (s >= 0) l.time = fmtTimestamp(Math.max(0, s + delta)); });
    this.#renderAllLines();
  }
  #clearTimes() {
    if (!this._lines.some((l) => l.time)) return;
    if (!confirm(this.t('lyrics.confirm.clearTimes'))) return;
    this.#record();
    this._lines.forEach((l) => { l.time = ''; });
    this.#renderAllLines();
  }
  #validateOrder() {
    const rows = this.#$('.le-lines').querySelectorAll('.le-row');
    let prev = -1;
    rows.forEach((r, idx) => {
      const s = parseLrcSeconds(this._lines[idx] && this._lines[idx].time);
      const bad = s >= 0 && prev >= 0 && s < prev;
      r.classList.toggle('le-row--bad-time', bad);
      if (bad) r.title = this.t('lyrics.editor.outOfOrder');
      else if (r.title === this.t('lyrics.editor.outOfOrder')) r.title = '';
      if (s >= 0) prev = s;
    });
  }
  #seekToLine(i) {
    const s = parseLrcSeconds(this._lines[i] && this._lines[i].time);
    if (s < 0 || !this._audio) return;
    this._audio.currentTime = s;
    if (this._audio.paused) this._audio.play().catch(() => {});
  }
  #seekProgress(e) {
    const dur = this._audio && this._audio.duration;
    if (!(dur > 0)) return;
    const r = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    this._audio.currentTime = frac * dur;
  }

  // ---------- modo letra ↔ acordes ----------
  #applyMode() {
    const inChords = this._mode === 'chords';
    const btn = this.#$('.le-mode-btn');
    if (btn) { btn.innerHTML = inChords ? ICON_CLEF : ICON_MIC; btn.title = this.t(inChords ? 'chords.editor.modeChords' : 'chords.editor.modeLyrics'); btn.classList.toggle('le-mode-active', inChords); }
    const colText = this.#$('.le-col-text-h');
    if (colText) colText.textContent = inChords ? this.t('chords.editor.colChord') : this.t('lyrics.editor.colText');
    this.classList.toggle('chords-mode', inChords);
  }
  #switchMode() {
    this._buf[this._mode] = this._lines;
    this._mode = this._mode === 'lyrics' ? 'chords' : 'lyrics';
    this._lines = this._buf[this._mode];
    this._focusIdx = 0; this._lastActiveIdx = -1;
    this._undo = []; this._redo = [];
    if (this._coalesce) { clearTimeout(this._coalesce); this._coalesce = null; }
    this.#applyMode();
    this.#renderAllLines();
  }

  // ---------- menu ----------
  #menuEl() { return this.#$('.le-menu'); }
  #menuOpen() { const m = this.#menuEl(); return m && !m.classList.contains('hidden'); }
  #menuShow() { const m = this.#menuEl(); if (m) m.classList.remove('hidden'); const b = this.#$('.le-menu-btn'); if (b) b.setAttribute('aria-expanded', 'true'); }
  #menuClose() { const m = this.#menuEl(); if (m) m.classList.add('hidden'); const b = this.#$('.le-menu-btn'); if (b) b.setAttribute('aria-expanded', 'false'); }

  // ---------- grid (imperativo) ----------
  #renderAllLines() {
    const grid = this.#$('.le-lines');
    if (!grid) return;
    grid.innerHTML = '';
    const slider = document.createElement('div');
    slider.id = 'leActiveSlider'; // reusa a CSS #leActiveSlider (o modal legado fica vazio)
    grid.appendChild(slider);
    this._lines.forEach((_, i) => {
      if (i > 0) grid.appendChild(this.#createInsertBtn(i));
      grid.appendChild(this.#createRow(i));
    });
    grid.appendChild(this.#createInsertBtn(this._lines.length));
    this._lastActiveIdx = -1;
    this.#updateLineCounter();
    this.#validateOrder();
    this._ticksDirty = true;
  }
  #updateLineCounter() { const el = this.#$('.le-line-count'); if (el) el.textContent = String(this._lines.filter((l) => l.text.trim()).length); }

  #createInsertBtn(insertAt) {
    const wrap = document.createElement('div');
    wrap.className = 'le-insert';
    const btn = document.createElement('button');
    btn.className = 'le-insert-btn'; btn.textContent = '+'; btn.type = 'button';
    btn.onclick = () => this.#insertLineAt(insertAt);
    wrap.appendChild(btn);
    return wrap;
  }

  #createRow(i) {
    const line = this._lines[i];
    const row = document.createElement('div');
    row.className = 'le-row'; row.dataset.idx = i;
    if (line.time) row.classList.add('le-row--has-time');

    const num = document.createElement('span');
    num.className = 'le-row-num'; num.textContent = String(i + 1);
    num.title = this.t('lyrics.editor.playFromLine');
    num.onclick = () => this.#seekToLine(i);
    if (line.time) num.classList.add('le-row-num--seek');

    const timeInp = document.createElement('input');
    timeInp.type = 'text'; timeInp.className = 'le-time'; timeInp.value = line.time;
    timeInp.placeholder = '00:00.00'; timeInp.spellcheck = false;
    timeInp.addEventListener('input', () => {
      this.#record(); this._lines[i].time = timeInp.value.trim();
      row.classList.toggle('le-row--has-time', !!timeInp.value.trim()); this.#validateOrder();
    });
    timeInp.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault(); this.#record();
        let s = parseLrcSeconds(this._lines[i].time);
        if (s < 0) s = (this._audio && this._audio.currentTime) || 0;
        s = Math.max(0, s + (e.key === 'ArrowUp' ? 0.1 : -0.1));
        const ts = fmtTimestamp(s);
        timeInp.value = ts; this._lines[i].time = ts; row.classList.add('le-row--has-time'); this.#validateOrder();
      }
    });
    timeInp.addEventListener('focus', () => { this._focusIdx = i; this.#setRowFocus(row); });
    timeInp.addEventListener('blur', () => {
      row.classList.remove('le-row--focus');
      const raw = timeInp.value.trim(); const norm = parseLrcTime(raw);
      if (raw && norm) { timeInp.value = norm; this._lines[i].time = norm; }
      else if (!raw) { this._lines[i].time = ''; }
      row.classList.toggle('le-row--has-time', !!this._lines[i].time); this.#validateOrder();
    });

    const textInp = document.createElement('textarea');
    textInp.className = 'le-text'; textInp.rows = 1; textInp.value = line.text;
    textInp.placeholder = this._mode === 'chords' ? this.t('chords.editor.placeholder') : (i === 0 ? 'Digite o primeiro verso da letra…' : '');
    textInp.spellcheck = true;
    textInp.addEventListener('input', () => { this.#record(); this._lines[i].text = textInp.value; this.#autoResize(textInp); this.#updateLineCounter(); });
    textInp.addEventListener('focus', () => { this._focusIdx = i; this.#setRowFocus(row); });
    textInp.addEventListener('blur', () => row.classList.remove('le-row--focus'));
    textInp.addEventListener('paste', (e) => {
      const clip = e.clipboardData || window.clipboardData;
      const text = clip && clip.getData('text');
      if (!text || !/\r|\n/.test(text)) return;
      e.preventDefault(); this.#record();
      const parsed = parseLyricsToLines(text);
      const cur = this._lines[i]; let at;
      if (!cur.text.trim() && !cur.time) { this._lines.splice(i, 1, ...parsed); at = i + parsed.length - 1; }
      else { this._lines.splice(i + 1, 0, ...parsed); at = i + parsed.length; }
      this.#renderAllLines(); this.#focusLineText(Math.min(at, this._lines.length - 1)); this.#updateLineCounter();
    });
    textInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); this.#record();
        if (textInp.value.trim() && (this._audio && (this._audio.currentTime > 0 || this._audio.duration))) {
          const ts = fmtTimestamp(this._audio.currentTime);
          timeInp.value = ts; this._lines[i].time = ts; row.classList.add('le-row--has-time');
        }
        const next = this._lines[i + 1];
        if (next && next.text.trim()) this.#focusLineText(i + 1); else this.#insertLineAt(i + 1);
        return;
      }
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); this.#insertLineAt(i + 1); return; }
      if (e.key === 'Backspace' && textInp.selectionStart === 0 && textInp.selectionEnd === 0 && i > 0) {
        e.preventDefault(); this.#record();
        const prev = this._lines[i - 1]; const joinPos = prev.text.length;
        prev.text = prev.text + textInp.value; this._lines.splice(i, 1);
        this.#renderAllLines();
        const rows = this.#$('.le-lines').querySelectorAll('.le-row');
        const ta = rows[i - 1] && rows[i - 1].querySelector('.le-text');
        if (ta) { ta.focus(); ta.setSelectionRange(joinPos, joinPos); this.#autoResize(ta); }
        this.#updateLineCounter();
        return;
      }
      if (e.key === 'ArrowUp' && textInp.selectionStart === 0) { e.preventDefault(); this.#focusLineText(i - 1); return; }
      if (e.key === 'ArrowDown' && textInp.selectionStart === textInp.value.length) { e.preventDefault(); this.#focusLineText(i + 1); return; }
    });

    const del = document.createElement('button');
    del.className = 'le-del'; del.type = 'button'; del.innerHTML = ICON_DEL_X;
    del.onclick = () => { if (this._lines.length > 1) this.#removeLineAt(i); };

    const grip = document.createElement('span');
    grip.className = 'le-grip'; grip.title = this.t('lyrics.editor.dragReorder'); grip.draggable = true; grip.innerHTML = ICON_GRIP;
    grip.addEventListener('dragstart', (e) => { this._dragFrom = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); row.classList.add('le-dragging'); });
    grip.addEventListener('dragend', () => { this._dragFrom = null; row.classList.remove('le-dragging'); this.#$('.le-lines').querySelectorAll('.le-drop-target').forEach((r) => r.classList.remove('le-drop-target')); });
    row.addEventListener('dragover', (e) => { if (this._dragFrom == null || this._dragFrom === i) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('le-drop-target'); });
    row.addEventListener('dragleave', () => row.classList.remove('le-drop-target'));
    row.addEventListener('drop', (e) => {
      e.preventDefault(); row.classList.remove('le-drop-target');
      const from = this._dragFrom; if (from == null || from === i) return;
      this.#record();
      const [moved] = this._lines.splice(from, 1);
      const to = from < i ? i - 1 : i;
      this._lines.splice(to, 0, moved); this._dragFrom = null;
      this.#renderAllLines(); this.#focusLineText(to);
    });

    row.append(grip, num, timeInp, textInp, del);
    requestAnimationFrame(() => this.#autoResize(textInp));
    return row;
  }

  #autoResize(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
  #setRowFocus(row) { this.#$('.le-lines').querySelectorAll('.le-row--focus').forEach((r) => r.classList.remove('le-row--focus')); row.classList.add('le-row--focus'); }
  #insertLineAt(idx) { this.#record(); this._lines.splice(idx, 0, { time: '', text: '' }); this.#renderAllLines(); this.#focusLineText(idx); this.#updateLineCounter(); }
  #removeLineAt(idx) { if (this._lines.length <= 1) return; this.#record(); this._lines.splice(idx, 1); this.#renderAllLines(); this.#focusLineText(Math.min(idx, this._lines.length - 1)); this.#updateLineCounter(); }
  #focusLineText(idx) {
    if (idx < 0 || idx >= this._lines.length) return;
    const rows = this.#$('.le-lines').querySelectorAll('.le-row');
    const txt = rows[idx] && rows[idx].querySelector('.le-text');
    if (txt) { txt.focus(); txt.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }

  // ---------- ticks de progresso ----------
  #buildTicks(dur) {
    const box = this.#$('.le-progress-ticks'); if (!box) return;
    box.innerHTML = ''; if (!(dur > 0)) return;
    this._lines.forEach((l) => {
      const s = parseLrcSeconds(l.time); if (s < 0) return;
      const tick = document.createElement('span'); tick.className = 'le-progress-tick';
      tick.style.left = Math.min(100, (s / dur) * 100) + '%'; box.appendChild(tick);
    });
  }

  // ---------- loop de destaque (rAF) ----------
  #startLoop() {
    this.#stopLoop();
    const scroll = this.#$('.le-content');
    let last = 0;
    const tick = () => {
      if (!this.isOpen()) { this._raf = null; return; }
      const now = performance.now();
      if (now - last > 120) {
        last = now;
        const a = this._audio; const grid = this.#$('.le-lines');
        if (a && grid) {
          const ct = a.currentTime; const dur = a.duration;
          if (dur > 0) {
            if (this._ticksDirty || this._ticksDur !== dur) { this.#buildTicks(dur); this._ticksDirty = false; this._ticksDur = dur; }
            const pct = Math.min(100, Math.max(0, (ct / dur) * 100));
            const fill = this.#$('.le-progress-fill'); const head = this.#$('.le-progress-head');
            if (fill) fill.style.width = pct + '%'; if (head) head.style.left = pct + '%';
          }
          let activeIdx = -1;
          for (let i = 0; i < this._lines.length; i++) { const s = parseLrcSeconds(this._lines[i].time); if (s >= 0 && s <= ct) activeIdx = i; }
          if (activeIdx !== this._lastActiveIdx) {
            this._lastActiveIdx = activeIdx;
            const rows = grid.querySelectorAll('.le-row');
            const slider = this.#$('#leActiveSlider');
            rows.forEach((r, idx) => r.classList.toggle('le-row--active', idx === activeIdx));
            if (slider) {
              if (activeIdx >= 0 && rows[activeIdx]) {
                const tr = rows[activeIdx]; const relTop = tr.offsetTop; const rh = tr.offsetHeight;
                slider.style.transform = `translateY(${relTop}px)`; slider.style.height = `${rh}px`; slider.style.opacity = '1';
                const userInRow = tr.contains(document.activeElement);
                if (scroll && !userInRow) {
                  const st = scroll.scrollTop, chh = scroll.clientHeight, margin = 80;
                  const fully = relTop >= st + margin && (relTop + rh) <= st + chh - margin;
                  if (!fully) scroll.scrollTo({ top: Math.max(0, relTop - chh / 2 + rh / 2), behavior: 'smooth' });
                }
              } else { slider.style.opacity = '0'; }
            }
          }
        }
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }
  #stopLoop() { if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; } }

  // ---------- teclado global do editor ----------
  #onKey(e) {
    if (!this.isOpen()) return;
    if (e.key === 'Escape') { if (this.#menuOpen()) { this.#menuClose(); return; } this.#tryClose(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); this.#undoAction(); return; }
    if ((e.ctrlKey || e.metaKey) && ((e.shiftKey && (e.key === 'z' || e.key === 'Z')) || e.key === 'y' || e.key === 'Y')) { e.preventDefault(); this.#redoAction(); return; }
    if (e.altKey && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); this.#seekToLine(this._focusIdx); return; }
    if (e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); this.#cycleSpeed(); return; }
    if ((e.ctrlKey || e.metaKey) && e.code === 'Space') { e.preventDefault(); if (this.player && this.player.toggle) this.player.toggle(); return; }
  }

  // ---------- salvar ----------
  #save() {
    const btn = this.#$('.le-save'); const orig = btn ? btn.innerHTML : null;
    if (btn) { btn.disabled = true; btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="le-spin"><circle cx="12" cy="12" r="10" stroke-dasharray="40" stroke-dashoffset="10"/></svg>${this.t('lyrics.editor.saving')}</span>`; }
    this._buf[this._mode] = this._lines;
    const lyrics = serializeLines(this._buf.lyrics);
    const chords = serializeLines(this._buf.chords);
    this._dirty = false;
    if (btn) { btn.disabled = false; if (orig) btn.innerHTML = orig; }
    // renderer persiste (grava tags + status + reload) e fecha
    this.emit('syn:lyrics-editor:save', { lyrics, chords });
    this.close();
  }
}

customElements.define('syn-lyrics-editor', SynLyricsEditor);

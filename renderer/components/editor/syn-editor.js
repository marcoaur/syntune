// <syn-editor> — editor de detalhes da faixa (cola). Controller montado uma vez (<syn-editor>
// vazio); OWNS por id o #editorBackdrop/#editor (UI = ilha syn-track-editor), o #cropModal
// (capa) e o #lyricsModal (letra). Dono do estado da faixa aberta + pipeline de capa, busca
// de metadados (IA), letra (LRCLIB/editor) e salvar tags.
//
// Estado da faixa nos campos do form (#title/#artist/...). current/audio vêm do playerStore.
// Capacidades: loading/confirm/palette. Efeitos cross-subsistema por INTENTS: syn:player:play
// (tocar a faixa), :before-save/:reload-current (suprime erro de stream no rewrite + recarrega
// karaokê/áudio), syn:library:reload, syn:devices:resync, syn:delete:open. Injetados pelo
// renderer: t, toast, coverState, makeCenterCrop.
import { loading, palette, confirm as confirmCap } from '../capabilities.js';
import { LYRICS_STATUS } from '../../modules/constants.js';
import { isSyncedLyrics, lrcToPlain } from '../../modules/lrc.js';
import { playerStore, libraryStore, devicesStore } from '../../services/core-store.js';
import '../track/syn-track-editor.js';

const FIELDS = ['title', 'artist', 'album', 'albumArtist', 'composer', 'year',
  'genre', 'trackNumber', 'partOfSet', 'publisher', 'comment', 'lyrics', 'chords'];

export class SynEditor extends HTMLElement {
  constructor() {
    super();
    this.t = (k) => k;
    this.toast = () => {};
    this.coverState = new Map();
    this.makeCenterCrop = async (s) => s;
    // estado da faixa aberta
    this.currentFilePath = null;
    this.currentEditorSong = null;
    this.currentImagePath = null;
    this.currentImageDataUrl = null;
    this.coverSourceDataUrl = null;
    this.currentYtContext = null;
    this._playcountCache = {};
    this._playcountPending = {};
    this._litCropper = null;
    this._litLyricsEditor = null;
    this._lePlayerWasHidden = false;
    this._wired = false;
  }

  #g(id) { return document.getElementById(id); }
  #emit(name, detail) { document.dispatchEvent(new CustomEvent(name, { detail })); }
  #paint() { return new Promise((r) => requestAnimationFrame(() => r())); }
  #getPalette(url) { return palette().of(url); }
  #askConfirm(message, opts = {}) { return confirmCap().ask({ message, cancelLabel: this.t('common.cancel'), ...opts }); }

  connectedCallback() {
    if (this._wired) return;
    this._wired = true;

    // Editor: roteador de cliques por DELEGAÇÃO no backdrop (nó estável; cobre a ilha
    // syn-track-editor que substitui o interior de #editor). Botões por id via closest().
    this.#g('editorBackdrop').addEventListener('click', (e) => {
      if (e.target === this.#g('editorBackdrop')) { this.#hide(); return; }
      const hit = (id) => e.target.closest('#' + id);
      if (hit('editorBack'))      { this.#hide(); return; }
      if (hit('editToggle'))      { this.#g('editor').classList.remove('view-mode'); this.#g('editor').classList.add('edit-mode'); return; }
      if (hit('editDone'))        { this.#save(); return; }
      if (hit('evPlay'))          { if (this.currentEditorSong) this.#emit('syn:player:play', { song: this.currentEditorSong }); return; }
      if (hit('removeImageBtn'))  { this.#resetCover(); return; }
      if (hit('adjustCoverBtn'))  { if (this.coverSourceDataUrl) this.#openCropper(); return; }
      if (hit('selectImageBtn'))  { this.#onSelectImage(); return; }
      if (hit('fetchBtn'))        { this.#onFetch(); return; }
      if (hit('lyricsStatusBtn')) { if (this.currentFilePath) this.#openLyricsModal(); return; }
      if (hit('deleteBtn'))       { this.#onDelete(); return; }
    });

    // colar imagem do clipboard (Ctrl+V com a capa em foco)
    document.addEventListener('paste', async (e) => {
      if (document.activeElement !== this.#g('coverPreview')) return;
      if (!this.currentFilePath) return;
      const items = (e.clipboardData && e.clipboardData.items) || [];
      let imageItem = null;
      for (const it of items) { if (it.kind === 'file' && it.type.startsWith('image/')) { imageItem = it; break; } }
      if (!imageItem) { this.toast(this.t('editor.pasteNoImage'), 'error'); return; }
      e.preventDefault();
      const blob = imageItem.getAsFile();
      if (!blob) return;
      try { const dataUrl = await this.#readBlob(blob); await this.#setCoverFromSource(dataUrl); this.#openCropper(); }
      catch { this.toast(this.t('editor.pasteReadFail'), 'error'); }
    });

    // lyricsModal
    this.#g('lmCloseBtn').addEventListener('click', () => this.#closeLyricsModal());
    this.#g('lyricsModal').addEventListener('click', (e) => { if (e.target === this.#g('lyricsModal')) this.#closeLyricsModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.#g('lyricsModal').classList.contains('hidden')) this.#closeLyricsModal(); });
    this.#g('lmSearchBtn').addEventListener('click', () => this.#lmSearch());
    this.#g('lmEditBtn').addEventListener('click', () => { this.#closeLyricsModal(); this.#openLyricsEditor(); });
    this.#g('lmPublishBtn').addEventListener('click', () => this.#lmPublish());
    this.#g('lmClearBtn').addEventListener('click', () => this.#lmClear());
  }

  #show() { this.#g('editorBackdrop').classList.remove('hidden', 'closing'); }
  #hide() { this.closeView(this.#g('editorBackdrop')); }
  closeView(el) { el.classList.add('hidden'); } // sobrescrito pelo renderer (closeViewAnimated)

  /** Acionador externo (menu da faixa): abre o editor para a faixa. */
  async open(song) {
    // faixa que só existe no dispositivo: traz a cópia para o PC antes de editar
    if (song.deviceOnly) {
      loading().show(this.t('editor.fetchingDevice'));
      await this.#paint();
      const res = await window.api.deviceEnrichFromDevice({ serial: song.serial, filePath: song.filePath });
      loading().hide();
      if (res.error) { this.toast(res.error, 'error'); return; }
      devicesStore.setDeviceOnlySongs(devicesStore.deviceOnlySongs.filter((s) => s.filePath !== song.filePath));
      this.#emit('syn:library:reload');
      song = { ...song, filePath: res.filePath, deviceOnly: false };
    }

    this.currentFilePath = song.filePath;
    this.currentEditorSong = song;
    this.currentYtContext = null;
    loading().show(this.t('editor.readingMeta'));
    await this.#paint();
    try {
      const tags = await window.api.readTags(song.filePath);
      if (tags.error) { this.toast(tags.error, 'error'); return; }
      this.#g('fileName').textContent = tags.fileName;
      FIELDS.forEach((f) => { if (this.#g(f)) this.#g(f).value = tags[f] || ''; });
      this.#g('hint').value = '';
      this.#g('aiStatus').classList.add('hidden');
      this.#updateLyricsStatusCard();

      this.#resetCover();
      if (song.coverDataUrl) {
        await this.#setCoverFromSource(song.coverDataUrl); // fluxo do YouTube: data URL transiente
      } else if (tags.hasCover) {
        const fetched = await window.api.getCover(song.filePath);
        if (fetched) await this.#setCoverFromSource(fetched);
        else this.#g('coverPreview').innerHTML = `<span class="cover-placeholder">${this.t('editor.embeddedCoverPh')}</span>`;
      }
      this.#g('editor').classList.remove('edit-mode');
      this.#g('editor').classList.add('view-mode');
      this.#renderView();
      this.#show();
    } catch (err) {
      this.toast(this.t('editor.openFail', { msg: (err && err.message ? err.message : err) }), 'error');
    } finally { loading().hide(); }
  }

  // ---- visualização (somente leitura) ----
  #renderView() {
    const get = (id) => (this.#g(id) ? this.#g(id).value.trim() : '');
    const fname = (this.#g('fileName').textContent || '').replace(/\.mp3$/i, '');
    this.#g('evTitle').textContent = get('title') || fname || '—';
    this.#g('evArtist').textContent = get('artist');
    this.#g('evAlbum').textContent = [get('album'), get('year')].filter(Boolean).join(' · ');

    const coverSrc = this.currentImageDataUrl || this.coverSourceDataUrl || (this.currentEditorSong && this.currentEditorSong.coverDataUrl) || null;
    this.#g('evCover').innerHTML = coverSrc ? `<img src="${coverSrc}" alt="" />` : '<span class="ph">♪</span>';
    this.#applyColor(coverSrc);

    this.#g('evLastfmStats').classList.add('hidden');
    this.#g('evGlobalPlays').textContent = '—';
    this.#g('evGlobalType').textContent = '—';
    this.#g('evGlobalTags').innerHTML = '';
    this.#g('evTagsCard').classList.add('hidden');
    this.#g('evTypeIcon').textContent = '🔥';
    this.#g('evTypeCard').className = 'ev-stat-card';

    const art = get('artist');
    const tit = get('title') || fname;
    const targetPath = this.currentEditorSong ? this.currentEditorSong.filePath : null;
    if (art && tit) {
      this.#fetchPlaycount(art, tit).then((res) => {
        if (!this.currentEditorSong || this.currentEditorSong.filePath !== targetPath) return;
        if (res && res.playcount) {
          const pc = parseInt(res.playcount, 10);
          const ls = parseInt(res.listeners, 10);
          this.#g('evGlobalPlays').textContent = this.#formatPlaycount(res.playcount);
          if (pc > 0 && ls > 0) {
            const ratio = pc / ls;
            if (ratio >= 6.5) {
              this.#g('evGlobalType').textContent = this.t('stats.cult');
              this.#g('evTypeIcon').textContent = '💎';
              this.#g('evTypeCard').className = 'ev-stat-card cult';
              this.#g('evTypeCard').title = this.t('stats.cultTitle', { ratio: ratio.toFixed(1) });
            } else {
              this.#g('evGlobalType').textContent = this.t('stats.hit');
              this.#g('evTypeIcon').textContent = '🔥';
              this.#g('evTypeCard').className = 'ev-stat-card hit';
              this.#g('evTypeCard').title = this.t('stats.hitTitle', { ratio: ratio.toFixed(1) });
            }
          } else {
            this.#g('evGlobalType').textContent = this.t('stats.standard');
            this.#g('evTypeIcon').textContent = '🎵';
            this.#g('evTypeCard').className = 'ev-stat-card';
          }
          if (res.tags && res.tags.length > 0) {
            res.tags.forEach((tag) => { const pill = document.createElement('span'); pill.className = 'ev-tag'; pill.textContent = tag; this.#g('evGlobalTags').appendChild(pill); });
            this.#g('evTagsCard').classList.remove('hidden', 'closing');
          } else this.#g('evTagsCard').classList.add('hidden');
          this.#g('evLastfmStats').classList.remove('hidden', 'closing');
        }
      });
    }

    const items = [
      [this.t('fields.genre'), get('genre')],
      [this.t('fields.albumArtist'), get('albumArtist')],
      [this.t('fields.composer'), get('composer')],
      [this.t('fields.trackNumber'), get('trackNumber')],
      [this.t('fields.partOfSet'), get('partOfSet')],
      [this.t('fields.publisher'), get('publisher')],
      [this.t('fields.comment'), get('comment'), true],
    ].filter(([, v]) => v);
    const box = this.#g('evMeta');
    box.innerHTML = '';
    for (const [label, value, full] of items) {
      const item = document.createElement('div');
      item.className = 'ev-meta-item' + (full ? ' full' : '');
      const l = document.createElement('div'); l.className = 'ev-meta-label'; l.textContent = label;
      const val = document.createElement('div'); val.className = 'ev-meta-value'; val.textContent = value;
      item.append(l, val);
      box.appendChild(item);
    }

    const lyrics = get('lyrics');
    const lyricsVisible = !!lyrics;
    this.#g('evLyricsWrap').classList.remove('hidden'); // ilha: painel de letra é o carro-chefe, sempre visível
    this.#g('evLyrics').textContent = isSyncedLyrics(lyrics) ? lrcToPlain(lyrics) : lyrics;
    this.#updateLyricsStatusCard();

    if (this.currentFilePath) {
      window.api.lyricsGetSyncStatus(this.currentFilePath).then((r) => {
        const badge = this.#g('evLyricsBadge');
        if (!badge) return;
        const statusKey = this.#computeLyricsStatus(r && r.status ? r.status : null, lyricsVisible);
        const st = LYRICS_STATUS[statusKey] || LYRICS_STATUS.empty;
        badge.className = 'ev-lyrics-badge ' + st.badgeCls;
        badge.textContent = this.t(st.badgeKey);
        badge.classList.toggle('hidden', !lyricsVisible || statusKey === 'empty');
      }).catch(() => {});
    } else { const badge = this.#g('evLyricsBadge'); if (badge) badge.classList.add('hidden'); }
  }
  async #applyColor(coverSrc) {
    const pal = coverSrc ? await this.#getPalette(coverSrc) : null;
    this.#g('editor').style.setProperty('--cv', pal ? `${pal.r}, ${pal.g}, ${pal.b}` : '124, 92, 255');
  }

  // ---- playcount (Last.fm) ----
  #formatPlaycount(numStr) {
    const num = parseInt(numStr, 10);
    if (isNaN(num)) return null;
    if (num >= 1000000) { const v = num / 1000000; return v >= 10 ? Math.round(v) + 'M' : v.toFixed(1).replace('.', this.t('meta.decimal')) + 'M'; }
    if (num >= 1000) { const v = num / 1000; return v >= 10 ? Math.round(v) + 'K' : v.toFixed(1).replace('.', this.t('meta.decimal')) + 'K'; }
    return num.toString();
  }
  #fetchPlaycount(artist, title) {
    const k = `${(artist || '').trim().toLowerCase()} - ${(title || '').trim().toLowerCase()}`;
    if (!(artist || '').trim() || !(title || '').trim()) return Promise.resolve(null);
    if (this._playcountCache[k] !== undefined) return Promise.resolve(this._playcountCache[k]);
    if (this._playcountPending[k]) return this._playcountPending[k];
    this._playcountPending[k] = window.api.lastfmGetPlaycount({ artist, title })
      .then((r) => { this._playcountCache[k] = r || null; return this._playcountCache[k]; })
      .catch(() => { this._playcountCache[k] = null; return null; })
      .finally(() => { delete this._playcountPending[k]; });
    return this._playcountPending[k];
  }
  /** Acionador externo (settings lastfmChanged): invalida o cache de playcount. */
  clearPlaycountCache() { this._playcountCache = {}; this._playcountPending = {}; }

  // ---- capa ----
  #resetCover() {
    this.currentImagePath = null; this.currentImageDataUrl = null; this.coverSourceDataUrl = null;
    this.#g('coverPreview').innerHTML = `<span class="cover-placeholder">${this.t('editor.noCoverPh')}</span>`;
    this.#g('removeImageBtn').classList.add('hidden');
    this.#g('adjustCoverBtn').classList.add('hidden');
  }
  #showCoverPreview(dataUrl) {
    this.#g('coverPreview').innerHTML = `<img src="${dataUrl}" alt="capa" />`;
    this.#g('removeImageBtn').classList.remove('hidden', 'closing');
    this.#g('adjustCoverBtn').classList.remove('hidden', 'closing');
  }
  async #setCoverFromSource(srcDataUrl) {
    this.coverSourceDataUrl = srcDataUrl;
    this.currentImagePath = null;
    try { this.currentImageDataUrl = await this.makeCenterCrop(srcDataUrl); }
    catch { this.currentImageDataUrl = srcDataUrl; }
    this.#showCoverPreview(this.currentImageDataUrl);
  }
  async #onSelectImage() {
    const p = await window.api.selectImage();
    if (!p) return;
    const dataUrl = await window.api.imagePreview(p);
    if (!dataUrl) { this.toast(this.t('editor.imageReadFail'), 'error'); return; }
    await this.#setCoverFromSource(dataUrl);
    this.#openCropper();
  }
  #readBlob(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); }); }

  // ---- buscar metadados (IA) ----
  async #onFetch() {
    if (!this.currentFilePath) return;
    const status = this.#g('aiStatus');
    status.className = 'ai-status';
    status.textContent = this.t('editor.aiQuerying');
    status.classList.remove('hidden', 'closing');
    this.#g('fetchBtn').disabled = true;
    const res = await window.api.smartMetadata({
      ytContext: this.currentYtContext || null,
      hint: this.#g('hint').value,
      raw: { fileName: this.#g('fileName').textContent, title: this.#g('title').value, artist: this.#g('artist').value, album: this.#g('album').value },
    });
    this.#g('fetchBtn').disabled = false;
    if (res.error) { status.className = 'ai-status error'; status.textContent = '⚠ ' + res.error; return; }
    const d = res.data || {};
    let filled = 0;
    for (const f of FIELDS) { if (d[f] && this.#g(f)) { this.#g(f).value = d[f]; filled++; } }
    if (res.coverDataUrl) { try { await this.#setCoverFromSource(res.coverDataUrl); } catch { /* mantém */ } }
    const src = (res.sources && res.sources.length) ? this.t('editor.aiSources', { list: res.sources.join(', ') }) : '';
    status.className = 'ai-status';
    status.textContent = this.t('editor.aiResult', { filled, cover: res.coverDataUrl ? this.t('editor.aiCover') : '', sources: src });
  }

  // ---- letra: status + modal ----
  #computeLyricsStatus(syncTag, hasLyrics) {
    if (!hasLyrics) { if (syncTag === 'not_found') return 'not_found'; return 'empty'; }
    if (syncTag === 'synced') return 'synced';
    if (syncTag === 'local' || syncTag === 'not_found') return 'local';
    return 'pending';
  }
  async #updateLyricsStatusCard() {
    const lyricsVal = (this.#g('lyrics') && this.#g('lyrics').value.trim()) || '';
    const hasLyrics = !!lyricsVal;
    let syncTag = null;
    if (this.currentFilePath) {
      try { const r = await window.api.lyricsGetSyncStatus(this.currentFilePath); syncTag = r && r.status ? r.status : null; } catch { /* sem tag */ }
    }
    const statusKey = this.#computeLyricsStatus(syncTag, hasLyrics);
    const st = LYRICS_STATUS[statusKey] || LYRICS_STATUS.empty;
    const titleEl = this.#g('lscTitle');
    if (titleEl) titleEl.textContent = this.t(st.titleKey);
    const subEl = this.#g('lscSub');
    if (subEl) {
      if (hasLyrics && statusKey !== 'empty') {
        const firstLine = lyricsVal.replace(/^\[.*?\]/gm, '').split('\n').find((l) => l.trim());
        subEl.textContent = firstLine ? (firstLine.length > 52 ? firstLine.slice(0, 49) + '…' : firstLine) : this.t(st.subKey);
      } else subEl.textContent = this.t(st.subKey);
    }
    const btn = this.#g('lyricsStatusBtn');
    if (btn) { btn.dataset.statusKey = statusKey; btn.dataset.syncTag = syncTag || ''; }
  }
  #openLyricsModal() {
    const modal = this.#g('lyricsModal');
    if (!modal) return;
    const lyricsVal = (this.#g('lyrics') && this.#g('lyrics').value.trim()) || '';
    const hasLyrics = !!lyricsVal;
    const statusKey = (this.#g('lyricsStatusBtn') && this.#g('lyricsStatusBtn').dataset.statusKey) || 'empty';
    const st = LYRICS_STATUS[statusKey] || LYRICS_STATUS.empty;
    const songTitle = this.#g('title') && this.#g('title').value.trim();
    this.#g('lmTitle').textContent = songTitle || this.t('lyrics.modal.title');
    const dot = this.#g('lmStatusDot'); if (dot) dot.className = 'lm-status-dot ' + st.dotCls;
    const stTxt = this.#g('lmStatusText'); if (stTxt) stTxt.textContent = this.t(st.subKey);

    const searchBtn = this.#g('lmSearchBtn');
    const searchLabel = this.#g('lmSearchLabel');
    const searchSub = searchBtn && searchBtn.querySelector('.lm-action-sub');
    if (searchLabel) {
      if (statusKey === 'synced') { searchLabel.textContent = this.t('lyrics.modal.searchAgain'); if (searchSub) searchSub.textContent = this.t('lyrics.modal.searchSubSynced'); }
      else if (statusKey === 'not_found') { searchLabel.textContent = this.t('lyrics.modal.searchAgain'); if (searchSub) searchSub.textContent = this.t('lyrics.modal.searchSubNotFound'); }
      else if (hasLyrics) { searchLabel.textContent = this.t('lyrics.modal.search'); if (searchSub) searchSub.textContent = this.t('lyrics.modal.searchSubReplace'); }
      else { searchLabel.textContent = this.t('lyrics.modal.search'); if (searchSub) searchSub.textContent = this.t('lyrics.modal.searchSub'); }
    }
    const editBtn = this.#g('lmEditBtn');
    const editLabel = editBtn && editBtn.querySelector('strong');
    const editSub = editBtn && editBtn.querySelector('.lm-action-sub');
    if (editLabel) {
      if (!hasLyrics) { editLabel.textContent = this.t('lyrics.modal.create'); if (editSub) editSub.textContent = this.t('lyrics.modal.createSub'); }
      else if (statusKey === 'synced') { editLabel.textContent = this.t('lyrics.modal.edit'); if (editSub) editSub.textContent = this.t('lyrics.modal.editSubSynced'); }
      else { editLabel.textContent = this.t('lyrics.modal.edit'); if (editSub) editSub.textContent = this.t('lyrics.modal.editSub'); }
    }
    const publishBtn = this.#g('lmPublishBtn');
    if (publishBtn) {
      const canPublish = hasLyrics && statusKey !== 'synced';
      publishBtn.classList.toggle('hidden', !canPublish);
      const publishLabel = publishBtn.querySelector('strong');
      const publishSub = publishBtn.querySelector('.lm-action-sub');
      if (publishLabel) publishLabel.textContent = this.t('lyrics.modal.publish');
      if (publishSub) publishSub.textContent = statusKey === 'pending' ? this.t('lyrics.modal.publishSubPending') : this.t('lyrics.modal.publishSub');
    }
    const clearBtn = this.#g('lmClearBtn');
    if (clearBtn) clearBtn.classList.toggle('hidden', !hasLyrics);
    modal.classList.remove('hidden');
    requestAnimationFrame(() => { const f = this.#g('lmSearchBtn'); if (f) f.focus(); });
  }
  #closeLyricsModal() { const m = this.#g('lyricsModal'); if (m) m.classList.add('hidden'); }

  #dur() { const a = playerStore.audio; return (playerStore.current && playerStore.current.filePath === this.currentFilePath && a && a.duration) ? a.duration : 0; }
  async #lmSearch() {
    const btn = this.#g('lmSearchBtn');
    btn.classList.add('lm-loading');
    const res = await window.api.fetchSyncedLyrics({ artist: this.#g('artist').value.trim(), title: this.#g('title').value.trim(), album: this.#g('album').value.trim(), duration: this.#dur() });
    btn.classList.remove('lm-loading');
    if (res.error) { this.toast(res.error, 'error'); return; }
    if (res.synced || res.plain) {
      this.#g('lyrics').value = res.synced || res.plain;
      if (this.currentFilePath) await window.api.lyricsSetSyncStatus(this.currentFilePath, 'synced');
      await this.#updateLyricsStatusCard();
      this.toast(this.t('lyrics.toast.synced'), 'success');
      this.#closeLyricsModal();
      this.#saveWithSync('synced');
    } else {
      if (this.currentFilePath) await window.api.lyricsSetSyncStatus(this.currentFilePath, 'not_found');
      await this.#updateLyricsStatusCard();
      this.toast(this.t('lyrics.toast.notFoundCreate'), '');
      this.#openLyricsModal();
    }
  }
  async #lmPublish() {
    const btn = this.#g('lmPublishBtn');
    btn.classList.add('lm-loading');
    const syncedLyrics = this.#g('lyrics').value.trim();
    const plainLyrics = lrcToPlain(syncedLyrics) || syncedLyrics;
    const dur = this.#dur();
    if (!dur) { btn.classList.remove('lm-loading'); this.toast(this.t('lyrics.toast.playFirst'), 'error'); return; }
    const pubRes = await window.api.lyricsPublish({
      trackName: this.#g('title').value.trim(), artistName: this.#g('artist').value.trim(), albumName: this.#g('album').value.trim(),
      duration: dur, plainLyrics, syncedLyrics, filePath: this.currentFilePath,
    });
    btn.classList.remove('lm-loading');
    if (pubRes.error) { this.toast(this.t('lyrics.toast.publishError', { msg: pubRes.error }), 'error'); }
    else { await this.#updateLyricsStatusCard(); this.toast(this.t('lyrics.toast.published'), 'success'); this.#closeLyricsModal(); this.#saveWithSync('synced'); }
  }
  async #lmClear() {
    if (!(await this.#askConfirm(this.t('lyrics.confirm.remove'), { danger: true, confirmLabel: this.t('common.delete') }))) return;
    this.#g('lyrics').value = '';
    if (this.currentFilePath) await window.api.lyricsSetSyncStatus(this.currentFilePath, 'not_found');
    await this.#updateLyricsStatusCard();
    this.toast(this.t('lyrics.toast.removed'), '');
    this.#closeLyricsModal();
    this.#saveWithSync('not_found');
  }

  // ---- editor de letra (ilha syn-lyrics-editor) ----
  #ensureLyricsEditor() {
    if (this._litLyricsEditor) return this._litLyricsEditor;
    const el = document.createElement('syn-lyrics-editor');
    el.classList.add('hidden');
    el.t = this.t; el.player = playerStore;
    el.addEventListener('syn:lyrics-editor:save', (e) => this.#onLyricsSave(e.detail));
    el.addEventListener('syn:lyrics-editor:close', () => this.#onLyricsClose());
    document.body.appendChild(el);
    this._litLyricsEditor = el;
    return el;
  }
  isLyricsEditorOpen() { return !!(this._litLyricsEditor && this._litLyricsEditor.isOpen()); }
  #openLyricsEditor() {
    const el = this.#ensureLyricsEditor();
    el.player = playerStore; el.t = this.t;
    el.open({ title: this.#g('title').value, artist: this.#g('artist').value, lyrics: this.#g('lyrics').value.trim(), chords: this.#g('chords').value.trim() });
    if (this.currentEditorSong) {
      const playing = playerStore.current && playerStore.current.filePath === this.currentEditorSong.filePath;
      if (!playing) this.#emit('syn:player:play', { song: this.currentEditorSong });
    }
    const playerEl = this.#g('player');
    if (playerEl) {
      this._lePlayerWasHidden = playerEl.classList.contains('hidden');
      playerEl.classList.remove('hidden');
      playerEl.style.position = 'fixed'; playerEl.style.bottom = '0'; playerEl.style.left = '0'; playerEl.style.right = '0'; playerEl.style.zIndex = '96';
    }
  }
  async #onLyricsSave({ lyrics, chords }) {
    this.#g('lyrics').value = lyrics; this.#g('chords').value = chords;
    if (this.currentFilePath) await window.api.lyricsSetSyncStatus(this.currentFilePath, 'local');
    await this.#updateLyricsStatusCard();
    this.#saveWithSync('local');
  }
  #onLyricsClose() {
    const playerEl = this.#g('player');
    if (playerEl) {
      playerEl.style.position = ''; playerEl.style.bottom = ''; playerEl.style.left = ''; playerEl.style.right = ''; playerEl.style.zIndex = '';
      if (this._lePlayerWasHidden) playerEl.classList.add('hidden');
    }
  }

  // ---- salvar ----
  async #save() {
    if (!this.currentFilePath) return;
    const payload = { filePath: this.currentFilePath, imagePath: this.currentImagePath, imageDataUrl: this.currentImageDataUrl, source: 'file', fields: {} };
    FIELDS.forEach((f) => { payload.fields[f] = this.#g(f) ? this.#g(f).value.trim() : ''; });
    payload.fields.lrclibSync = null; // preserva o status atual ao salvar metadados normais

    const saveBtnEl = this.#g('editDone');
    const origInner = saveBtnEl ? saveBtnEl.innerHTML : null;
    if (saveBtnEl) {
      saveBtnEl.disabled = true;
      saveBtnEl.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="le-spin"><circle cx="12" cy="12" r="10" stroke-dasharray="40" stroke-dashoffset="10"/></svg>';
    }
    loading().show(this.t('editor.savingTags'));
    await this.#paint();
    this.#emit('syn:player:before-save', { filePath: this.currentFilePath }); // suprime erro de stream no rewrite
    let res;
    try { res = await window.api.saveTags(payload); }
    catch (err) { this.toast(this.t('editor.saveFail', { msg: (err && err.message ? err.message : err) }), 'error'); return; }
    finally { loading().hide(); if (saveBtnEl) saveBtnEl.disabled = false; }
    if (res.error) { this.toast(res.error, 'error'); return; }
    if (saveBtnEl && origInner) {
      saveBtnEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#34c759" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M20 6 9 17l-5-5"/></svg>';
      await new Promise((r) => setTimeout(r, 600));
      saveBtnEl.innerHTML = origInner;
    }
    this.toast(this.t('editor.saved'), 'success');
    this.coverState.delete(this.currentFilePath);
    if (res.savedPath) this.coverState.delete(res.savedPath);
    this.#emit('syn:library:reload');
    this.#emit('syn:devices:resync');
    if (this.currentEditorSong) {
      const updated = libraryStore.songs.find((x) => x.filePath === this.currentFilePath);
      if (updated) this.currentEditorSong = updated;
    }
    this.#emit('syn:player:reload-current', { filePath: this.currentFilePath });
    this.#renderView();
    this.#g('editor').classList.remove('edit-mode');
    this.#g('editor').classList.add('view-mode');
  }
  async #saveWithSync(lrclibSync) {
    if (!this.currentFilePath) return;
    const payload = { filePath: this.currentFilePath, imagePath: this.currentImagePath, imageDataUrl: this.currentImageDataUrl, source: 'file', fields: {} };
    FIELDS.forEach((f) => { payload.fields[f] = this.#g(f) ? this.#g(f).value.trim() : ''; });
    payload.fields.lrclibSync = lrclibSync;
    this.#emit('syn:player:before-save', { filePath: this.currentFilePath });
    try { const res = await window.api.saveTags(payload); if (res && res.error) console.warn('[saveWithSync]', res.error); }
    catch (err) { console.warn('[saveWithSync]', err); }
    await this.#updateLyricsStatusCard();
    this.coverState.delete(this.currentFilePath);
    this.#emit('syn:library:reload');
    this.#emit('syn:devices:resync');
    this.#emit('syn:player:reload-current', { filePath: this.currentFilePath });
  }

  #onDelete() {
    if (!this.currentFilePath) return;
    const s = libraryStore.songs.find((x) => x.filePath === this.currentFilePath)
      || devicesStore.deviceOnlySongs.find((x) => x.filePath === this.currentFilePath)
      || { filePath: this.currentFilePath, fileName: this.#g('fileName').textContent, title: this.#g('title').value, artist: this.#g('artist').value };
    this.#hide();
    this.#emit('syn:delete:open', { song: s });
  }

  // ---- cropper de capa (ilha syn-cropper) ----
  #ensureCropper() {
    if (this._litCropper) return;
    const sheet = document.querySelector('#cropModal .crop-sheet');
    if (!sheet) return;
    const stage = this.#g('cropStage'); if (stage) stage.style.display = 'none';
    const ctrls = sheet.querySelector('.crop-controls'); if (ctrls) ctrls.style.display = 'none';
    const actions = sheet.querySelector('.sheet-actions'); if (actions) actions.style.display = 'none';
    const c = document.createElement('syn-cropper');
    c.applyLabel = this.t('crop.apply');
    c.cancelLabel = this.t('common.cancel');
    c.addEventListener('syn:cover:crop', (e) => { this.currentImageDataUrl = e.detail.dataUrl; this.currentImagePath = null; this.#showCoverPreview(this.currentImageDataUrl); this.closeCropper(); });
    c.addEventListener('syn:cover:cancel', () => this.closeCropper());
    sheet.appendChild(c);
    this._litCropper = c;
  }
  #openCropper() {
    if (!this.coverSourceDataUrl) return;
    this.#ensureCropper();
    this._litCropper.src = this.coverSourceDataUrl;
    this.#g('cropModal').classList.remove('hidden', 'closing');
  }
  /** público p/ o renderer fechar no Escape. */
  closeCropper() { this.closeView(this.#g('cropModal')); }
  /** Acionador externo: editor está aberto (em edição → volta p/ view; senão fecha). Escape. */
  onEscape() {
    if (this.#g('editor').classList.contains('edit-mode')) {
      this.#g('editor').classList.remove('edit-mode'); this.#g('editor').classList.add('view-mode'); this.#renderView();
    } else this.#hide();
  }
}
customElements.define('syn-editor', SynEditor);

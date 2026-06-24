// <syn-playlists> — VIEW inteligente (ARCHITECTURE-V2) das Playlists. ADOTA o markup das
// duas telas (#playlistsView grade + #playlistPage página, tag-swap no index.html: ambas
// envolvidas por <syn-playlists>) e é DONA do domínio: estado (playlistsStore), CRUD,
// render da grade/página, reordenação (drag), rename inline, export M3U, sync no device e o
// menu "adicionar à playlist". NÃO re-renderiza o próprio host (preserva markup/IDs/CSS).
//
// Contrato: trata os próprios eventos; acionadores externos = métodos públicos
// (open/openPage/closePage/closeGrid/addToPlaylistMenu). Estado central vem dos STORES
// (playlistsStore/libraryStore/devicesStore) — sem deps de estado do renderer. Efeitos
// cross-subsistema saem por INTENTS (syn:player:play-list / :mark-cards / syn:library:refresh)
// que o renderer executa. Cards de faixa = folha compartilhada buildSongCard. Injetados pelo
// renderer (glue/UI): t, tn, toast, closeView, showScanIndicator, hideScanIndicator,
// getPalette, coverUrl, coverState.
import { menu, confirm as confirmCap } from '../capabilities.js';
import { buildSongCard } from '../song/build-song-card.js';
import { ICONS } from '../../modules/icons.js';
import { normalizeText } from '../../modules/format.js';
import { playlistsStore, libraryStore, devicesStore } from '../../services/core-store.js';
import './syn-playlist-card.js';

export class SynPlaylists extends HTMLElement {
  constructor() {
    super();
    // injetados pelo renderer
    this.t = (k) => k;
    this.tn = (k) => k;
    this.toast = () => {};
    this.closeView = (el) => el.classList.add('hidden');
    this.showScanIndicator = () => {};
    this.hideScanIndicator = () => {};
    this.getPalette = async () => null;
    this.coverUrl = () => '';
    this.coverState = new Map();
    // estado local da view
    this.currentPlaylistId = null;
    this._dragFrom = -1;
    this._wired = false;
  }

  #$(sel) { return this.querySelector(sel); }
  #emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail })); }

  connectedCallback() {
    if (this._wired) return; // idempotente (markup já no DOM)
    this._wired = true;
    const $ = (s) => this.#$(s);

    // grade: delegação dos cards <syn-playlist-card>
    $('#plGrid').addEventListener('syn:playlist:open', (e) => this.openPage(e.detail.id));
    $('#plViewBack').addEventListener('click', () => this.closeGrid());
    $('#plNewBtn').addEventListener('click', () => this.#newPlaylistFlow());

    // página
    $('#ppBack').addEventListener('click', () => { this.closePage(); this.open(); });
    $('#ppPlay').addEventListener('click', () => { const p = this.#find(this.currentPlaylistId); if (p) this.#emit('syn:player:play-list', { songs: this.#songs(p) }); });
    $('#ppRename').addEventListener('click', () => this.#renameInline());
    $('#ppDelete').addEventListener('click', () => this.#deleteCurrent());
    $('#ppExport').addEventListener('click', () => this.#exportCurrent());
    $('#ppSync').addEventListener('click', () => this.#syncCurrent());
  }

  // ---- domínio ----
  async load() { await playlistsStore.load(); }
  #save() { return playlistsStore.save(); }
  #find(id) { return playlistsStore.playlists.find((p) => p.id === id); }
  #songs(p) {
    const byPath = new Map(libraryStore.songs.map((s) => [s.filePath, s]));
    return (p.tracks || []).map((fp) => byPath.get(fp)).filter(Boolean);
  }
  #coverHtml(pSongs) {
    const covers = [];
    const seenAlbums = new Set();
    for (const s of pSongs) {
      if (this.coverState.get(s.filePath) === false) continue;
      const k = normalizeText(s.album || '') || s.filePath; // dedupe por álbum (ou arquivo)
      if (seenAlbums.has(k)) continue;
      seenAlbums.add(k);
      covers.push(this.coverUrl(s));
      if (covers.length >= 4) break;
    }
    if (!covers.length) return '<span class="pl-cover-ph">♪</span>';
    if (covers.length < 4) return `<span class="pl-cover-ph" style="background-image:url('${covers[0]}');background-size:cover;background-position:center"></span>`;
    return covers.map((c) => `<img src="${c}" alt="" />`).join('');
  }

  #create(name) {
    const p = { id: 'pl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5), name: name || this.t('playlists.new'), tracks: [], createdAt: Date.now() };
    playlistsStore.playlists.push(p);
    this.#save();
    return p;
  }
  #add(id, filePath) {
    const p = this.#find(id); if (!p) return;
    if (!p.tracks.includes(filePath)) { p.tracks.push(filePath); this.#save(); this.toast(this.t('playlists.addedTo', { name: p.name }), 'success'); }
    else this.toast(this.t('playlists.alreadyIn'), '');
  }
  #remove(id, filePath) {
    const p = this.#find(id); if (!p) return;
    const i = p.tracks.indexOf(filePath);
    if (i >= 0) { p.tracks.splice(i, 1); this.#save(); if (this.currentPlaylistId === id) this.openPage(id); }
  }
  #reorder(id, from, to) {
    const p = this.#find(id); if (!p) return;
    const arr = p.tracks;
    if (from < 0 || from >= arr.length || to < 0 || to >= arr.length) return;
    const [m] = arr.splice(from, 1);
    arr.splice(to, 0, m);
    this.#save();
    this.openPage(id);
  }

  // ---- grade ----
  /** Acionador externo: abre a grade de playlists. */
  open() {
    this.#renderGrid();
    const v = this.#$('#playlistsView');
    v.classList.remove('hidden', 'closing');
    v.querySelector('.ap-scroll').scrollTop = 0;
  }
  closeGrid() { this.closeView(this.#$('#playlistsView')); }
  #renderGrid() {
    const grid = this.#$('#plGrid');
    grid.innerHTML = '';
    for (const p of playlistsStore.playlists) {
      const ps = this.#songs(p);
      const c = document.createElement('syn-playlist-card');
      c.pid = p.id; c.name = p.name; c.sub = this.tn('count.track', p.tracks.length); c.coverHtml = this.#coverHtml(ps);
      grid.appendChild(c);
    }
    const add = document.createElement('div'); // card "Nova playlist"
    add.className = 'pl-card pl-new';
    add.innerHTML = `<div class="pl-cover">${ICONS.plusSm}</div><div class="pl-card-name">${this.t('playlists.new')}</div><div class="pl-card-sub">${this.t('playlists.create')}</div>`;
    add.addEventListener('click', () => this.#newPlaylistFlow());
    grid.appendChild(add);
    this.#$('#plEmpty').classList.toggle('hidden', playlistsStore.playlists.length > 0);
  }
  #newPlaylistFlow() {
    const p = this.#create();
    this.openPage(p.id);
    setTimeout(() => this.#renameInline(), 80); // já abre pronto para nomear
  }

  // ---- página ----
  /** Acionador externo: abre a página de uma playlist. */
  openPage(id) {
    const p = this.#find(id);
    if (!p) { this.closePage(); return; }
    this.currentPlaylistId = id;
    const ps = this.#songs(p);
    const $ = (s) => this.#$(s);

    $('#ppName').textContent = p.name;
    $('#ppStats').textContent = this.tn('count.song', ps.length);
    $('#ppCover').innerHTML = this.#coverHtml(ps);

    // ambiente derivado da 1ª capa
    const page = $('#playlistPage');
    const firstCover = ps.find((s) => this.coverState.get(s.filePath) !== false);
    if (firstCover) {
      this.getPalette(this.coverUrl(firstCover)).then((pal) => {
        if (pal) page.style.setProperty('--cv', `${pal.r}, ${pal.g}, ${pal.b}`);
      });
    } else page.style.setProperty('--cv', '124, 92, 255');

    const box = $('#ppTracks');
    box.innerHTML = '';
    ps.forEach((s, i) => box.appendChild(this.#buildRow(s, ps, i, id)));
    $('#ppEmpty').classList.toggle('hidden', ps.length > 0);

    page.classList.remove('hidden', 'closing');
    page.querySelector('.ap-scroll').scrollTop = 0;
    this.#emit('syn:player:mark-cards');
  }
  closePage() { this.closeView(this.#$('#playlistPage')); this.currentPlaylistId = null; }

  #buildRow(s, pSongs, index, id) {
    const card = buildSongCard(s, pSongs);
    card.classList.add('pp-row');
    card.draggable = true;
    // handle + remover vêm no TEMPLATE (modo row) — não injetar no light-DOM (re-render apaga)
    card.vm = { ...card.vm, row: true };
    card.addEventListener('syn:song:remove', () => this.#remove(id, s.filePath));

    card.addEventListener('dragstart', () => { this._dragFrom = index; card.classList.add('dragging'); });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      this.querySelectorAll('.pp-row.drop-target').forEach((el) => el.classList.remove('drop-target'));
      this._dragFrom = -1;
    });
    card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drop-target'); });
    card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
    card.addEventListener('drop', (e) => {
      e.preventDefault(); card.classList.remove('drop-target');
      if (this._dragFrom < 0 || this._dragFrom === index) return;
      this.#reorder(id, this._dragFrom, index);
    });
    return card;
  }

  #renameInline() {
    const p = this.#find(this.currentPlaylistId); if (!p) return;
    const nameEl = this.#$('#ppName');
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'pp-name-input'; input.value = p.name;
    nameEl.textContent = ''; nameEl.appendChild(input);
    input.focus(); input.select();
    const commit = async () => {
      const v = input.value.trim() || p.name;
      p.name = v; await this.#save();
      nameEl.textContent = v;
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      else if (e.key === 'Escape') { input.value = p.name; input.blur(); }
    });
    input.addEventListener('blur', commit, { once: true });
  }

  async #deleteCurrent() {
    const p = this.#find(this.currentPlaylistId); if (!p) return;
    const ok = await confirmCap().ask({ message: this.t('playlists.deleteConfirm', { name: p.name }), cancelLabel: this.t('common.cancel'), danger: true, confirmLabel: this.t('common.delete') });
    if (!ok) return;
    playlistsStore.setPlaylists(playlistsStore.playlists.filter((x) => x.id !== p.id));
    await this.#save();
    this.closePage();
    this.open();
    this.toast(this.t('playlists.deleted'), 'success');
  }
  async #exportCurrent() {
    const p = this.#find(this.currentPlaylistId); if (!p || !p.tracks.length) { this.toast(this.t('playlists.empty'), 'error'); return; }
    const res = await window.api.playlistExportM3u({ name: p.name, tracks: p.tracks });
    if (res && res.error) { this.toast(res.error, 'error'); return; }
    if (res && res.success) this.toast(this.t('playlists.exported'), 'success');
  }
  async #syncCurrent() {
    const p = this.#find(this.currentPlaylistId); if (!p || !p.tracks.length) { this.toast(this.t('playlists.empty'), 'error'); return; }
    if (!devicesStore.activeDevice) { this.toast(this.t('playlists.connectDevice'), 'error'); return; }
    this.showScanIndicator(this.t('playlists.syncing'));
    const res = await window.api.playlistSyncToDevice({ serial: devicesStore.activeDevice.serial, name: p.name, tracks: p.tracks });
    this.hideScanIndicator();
    if (res && res.error) { this.toast(res.error, 'error'); return; }
    try { const st = await window.api.deviceSyncState(devicesStore.activeDevice.serial); devicesStore.setSyncedKeys(st.keys || []); this.#emit('syn:library:refresh'); } catch { /* ok */ }
    this.toast(this.t('playlists.syncResult', {
      count: res.count,
      copied: res.copied ? this.t('playlists.syncCopied', { n: res.copied }) : '',
    }), 'success');
  }

  /** Acionador externo (menu da faixa no renderer): menu "adicionar à playlist". */
  addToPlaylistMenu(s, anchorEl) {
    const items = [{ head: this.t('playlists.addToMenu') }];
    for (const p of playlistsStore.playlists) {
      items.push({ icon: ICONS.queue, label: p.name, onClick: () => this.#add(p.id, s.filePath) });
    }
    items.push({ sep: true });
    items.push({ icon: ICONS.plusSm, label: this.t('playlists.new'), onClick: () => {
      const p = this.#create(); p.tracks.push(s.filePath); this.#save();
      this.toast(this.t('playlists.createdWithTrack', { name: p.name }), 'success');
    } });
    menu().open(anchorEl, items);
  }
}
customElements.define('syn-playlists', SynPlaylists);

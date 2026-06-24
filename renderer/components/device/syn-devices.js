// <syn-devices> — VIEW inteligente (ARCHITECTURE-V2) da central de dispositivos/sync. ADOTA
// o markup do modal (tag-swap de #devicesModal → <syn-devices id="devicesModal">; light-DOM,
// sem re-render → preserva IDs/CSS) e é DONA do domínio: lista de dispositivos, capacidade/
// progresso por-serial, fluxo varredura→sync (worker no main), notificação de conexão e o
// contexto de badges. Gerencia também a faixa #deviceNotice (markup fora do modal) por id.
//
// Estado central nos STORES (devicesStore: activeDevice/syncedKeys/hasSyncContext/
// deviceOnlySongs). Efeito cross-subsistema = intent syn:library:refresh (a biblioteca
// re-renderiza com as faixas device-only/badges). Injetados pelo renderer (glue/UI):
// t, tn, toast, closeView, showScanIndicator, hideScanIndicator (status na toolbar).
// Acionadores externos: open/close/resync/initContext (métodos públicos).
import { normPart, fmtBytes, cssEsc } from '../../modules/format.js';
import { libraryStore, devicesStore } from '../../services/core-store.js';
import './syn-device.js';

export class SynDevices extends HTMLElement {
  constructor() {
    super();
    this.t = (k) => k;
    this.tn = (k) => k;
    this.toast = () => {};
    this.closeView = (el) => el.classList.add('hidden');
    this.showScanIndicator = () => {};
    this.hideScanIndicator = () => {};
    // estado local
    this.deviceStats = {};     // serial -> { pendingCount, pendingBytes }
    this.deviceConnInfo = {};  // serial -> { free, size, connected }
    this.syncBusy = false;
    this.syncQueued = null;
    this.lastAttachedSerial = null;
    this.showingIgnored = false;
    this._wired = false;
  }

  #$(sel) { return this.querySelector(sel); }
  #emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail })); }
  #refreshLibrary() { this.#emit('syn:library:refresh'); }
  #setBusy(b) { const el = document.getElementById('devicesBtn'); if (el) el.classList.toggle('syncing', b); }

  connectedCallback() {
    if (this._wired) return; // idempotente (markup já no DOM)
    this._wired = true;

    // sheet
    this.#$('#closeDevices').addEventListener('click', () => this.close());
    this.addEventListener('click', (e) => { if (e.target === this) this.close(); });
    this.#$('#toggleIgnored').addEventListener('click', () => {
      this.showingIgnored = !this.showingIgnored;
      this.#$('#toggleIgnored').textContent = this.showingIgnored ? this.t('devices.hideIgnored') : this.t('devices.showIgnored');
      this.#$('#ignoredList').classList.toggle('hidden', !this.showingIgnored);
    });

    // intents do <syn-device> (delegados no modal; eventos bubbles+composed)
    this.addEventListener('syn:device:nick', (e) => window.api.devicesUpdate({ serial: e.detail.serial, nickname: e.detail.nickname }));
    this.addEventListener('syn:device:sync-toggle', async (e) => {
      const { serial, enabled, connected, nickname, label } = e.detail;
      await window.api.devicesUpdate({ serial, syncEnabled: enabled });
      await this.renderList();
      if (enabled && connected) this.#scanAndSync({ serial, nickname, label, configured: true, syncEnabled: true });
      else if (!enabled && devicesStore.activeDevice && devicesStore.activeDevice.serial === serial) {
        devicesStore.setActiveDevice(null); devicesStore.setDeviceOnlySongs([]); this.#refreshLibrary();
      }
    });
    this.addEventListener('syn:device:scope', (e) => { this.#persistScope(e.detail.serial, e.detail.scope); this.#refreshStats(e.detail.serial); });
    this.addEventListener('syn:device:ignore', async (e) => { await window.api.devicesUpdate({ serial: e.detail.serial, ignored: e.detail.ignored }); await this.renderList(); });
    this.addEventListener('syn:device:sync-now', (e) => this.#scanAndSync({ serial: e.detail.serial, nickname: e.detail.nickname, label: e.detail.label, configured: true, syncEnabled: true }));

    // notificação de dispositivo conectado (markup fora do modal)
    const notice = document.getElementById('deviceNotice');
    if (notice) {
      notice.addEventListener('click', (e) => {
        if (e.target === document.getElementById('deviceNoticeClose')) return;
        this.#hideNotice(); this.open();
      });
      document.getElementById('deviceNoticeClose').addEventListener('click', (e) => { e.stopPropagation(); this.#hideNotice(); });
    }

    // ponte IPC de conexão/desconexão/progresso
    window.api.onDeviceAttached(async (info) => {
      if (info.ignored) return;
      if (info.configured && info.syncEnabled) await this.#scanAndSync(info);
      else this.#showNotice(info);
    });
    window.api.onDeviceDetached((info) => {
      if (devicesStore.activeDevice && devicesStore.activeDevice.serial === info.serial) {
        devicesStore.setActiveDevice(null);
        devicesStore.setDeviceOnlySongs([]);
        this.#refreshLibrary(); // mantém os badges com o último estado conhecido (sync.json)
      }
      if (this.lastAttachedSerial === info.serial) this.#hideNotice();
      if (!this.classList.contains('hidden')) this.renderList(); // atualiza a sheet se aberta
    });
    window.api.onSyncProgress((p) => {
      if (this.syncBusy) {
        if (p.phase === 'sync') this.showScanIndicator(p.total ? this.t('sync.syncingN', { done: p.done, total: p.total }) : this.t('sync.syncing'));
        else this.showScanIndicator(this.t('sync.scanning'));
      }
      this.#updateRowProgress(p.serial, p);
    });
  }

  // ---- helpers de capacidade / progresso (por-serial, na sheet) ----
  #artists() {
    const m = new Map();
    for (const s of libraryStore.songs) {
      const k = normPart(s.artist || '');
      if (!m.has(k)) m.set(k, (s.artist || '').trim() || this.t('library.noArtist'));
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], this.t('meta.locale')));
  }
  #paintCapacity(el, info, stats) {
    const size = info.size || 0, free = info.free || 0;
    const used = Math.max(0, size - free);
    const pend = stats ? (stats.pendingBytes || 0) : null;
    const usedPct = size ? (used / size) * 100 : 0;
    const pendPct = size ? (Math.min(pend || 0, free) / size) * 100 : 0;

    el.innerHTML = '';
    const bar = document.createElement('div');
    bar.className = 'cap-bar';
    const u = document.createElement('div'); u.className = 'cap-used'; u.style.width = usedPct + '%';
    const p = document.createElement('div'); p.className = 'cap-pending'; p.style.width = pendPct + '%';
    bar.append(u, p);

    const label = document.createElement('div');
    label.className = 'cap-label';
    let txt = this.t('devices.freeOf', { free: fmtBytes(free), size: fmtBytes(size) });
    if (pend == null) txt += this.t('devices.calculating');
    else if (pend > 0) txt += this.t('devices.missing', { bytes: fmtBytes(pend) }) +
      (stats.pendingCount ? this.t('devices.missingTracks', { tracks: this.tn('count.track', stats.pendingCount) }) : '');
    else txt += this.t('devices.upToDateCap');
    label.textContent = txt;
    if (pend != null && pend > free) label.classList.add('warn-text');

    el.append(bar, label);
  }
  #paintCapacityRow(serial) {
    const row = this.querySelector(`.device-row[data-serial="${cssEsc(serial)}"]`);
    if (!row) return;
    const cap = row.querySelector('.device-capacity');
    if (cap) this.#paintCapacity(cap, this.deviceConnInfo[serial] || {}, this.deviceStats[serial]);
  }
  #updateRowProgress(serial, p) {
    const row = this.querySelector(`.device-row[data-serial="${cssEsc(serial)}"]`);
    if (!row) return;
    const prog = row.querySelector('.device-progress');
    if (!prog) return;
    prog.classList.remove('hidden', 'closing');
    const bar = prog.querySelector('.dp-bar > div');
    const txt = prog.querySelector('.dp-text');
    if (p.phase === 'sync') {
      if (bar) bar.style.width = (p.percent || 0) + '%';
      if (txt) txt.textContent = p.current ? this.t('sync.syncingCur', { done: p.done, total: p.total, current: p.current }) : this.t('sync.syncing');
    } else {
      if (bar) bar.style.width = '100%';
      if (txt) txt.textContent = (p.total != null && p.done != null)
        ? this.t('sync.syncingN', { done: p.done, total: p.total })
        : this.t('sync.scanning');
    }
  }
  #hideRowProgress(serial) {
    const row = this.querySelector(`.device-row[data-serial="${cssEsc(serial)}"]`);
    if (row) { const prog = row.querySelector('.device-progress'); if (prog) prog.classList.add('hidden'); }
  }
  async #refreshStats(serial) {
    if (this.syncBusy) return; // não concorre com o fluxo principal
    const info = this.deviceConnInfo[serial];
    if (!info || !info.connected) return;
    try {
      const scan = await window.api.deviceScan(serial);
      if (scan && !scan.error) {
        this.deviceStats[serial] = { pendingCount: scan.pendingCount, pendingBytes: scan.pendingBytes || 0 };
        this.#paintCapacityRow(serial);
      }
    } finally { this.#hideRowProgress(serial); }
  }
  #persistScope(serial, scope) {
    return window.api.devicesUpdate({
      serial,
      syncScope: scope.mode === 'artists' ? { mode: 'artists', artists: scope.artists } : { mode: 'all' },
    });
  }

  // ---- notificação ----
  #showNotice(info) {
    this.lastAttachedSerial = info.serial;
    const label = info.label || info.model || this.t('devices.storage');
    document.getElementById('deviceNoticeSub').textContent = this.t('deviceNotice.subLabel', { label });
    document.getElementById('deviceNotice').classList.remove('hidden', 'closing');
  }
  #hideNotice() { const n = document.getElementById('deviceNotice'); if (n) n.classList.add('hidden'); }

  // ---- fluxo varredura → sincronização (worker no main; chamadas coalescidas) ----
  async #scanAndSync(info) {
    if (this.syncBusy) { this.syncQueued = info; return; }
    this.syncBusy = true;
    this.#setBusy(true);
    devicesStore.setActiveDevice({ serial: info.serial, nickname: info.nickname, label: info.label });
    this.showScanIndicator(this.t('sync.scanning'));
    try {
      const scan = await window.api.deviceScan(info.serial);
      if (scan && scan.error) { this.toast(scan.error, 'error'); return; }
      if (Array.isArray(scan.syncedKeys)) devicesStore.setSyncedKeys(scan.syncedKeys);
      devicesStore.setHasSyncContext(true);
      devicesStore.setDeviceOnlySongs(scan.deviceOnly || []);
      this.deviceStats[info.serial] = { pendingCount: scan.pendingCount, pendingBytes: scan.pendingBytes || 0 };
      this.#paintCapacityRow(info.serial);
      this.#refreshLibrary();

      this.showScanIndicator(scan.pendingCount ? this.t('sync.syncingN', { done: 0, total: scan.pendingCount }) : this.t('sync.syncing'));
      const res = await window.api.deviceSync(info.serial);
      if (res && res.error) { this.toast(res.error, 'error'); return; }
      if (res && res.queued) return; // outra sincronização assumiu; sem toast

      if (Array.isArray(res.syncedKeys)) devicesStore.setSyncedKeys(res.syncedKeys);
      this.deviceStats[info.serial] = { pendingCount: res.failed || 0, pendingBytes: 0 };
      this.#paintCapacityRow(info.serial);
      this.#refreshLibrary();

      const nick = info.nickname || info.label || this.t('deleteModal.deviceFallback');
      if (res.copied > 0) this.toast(this.t('sync.copied', { n: res.copied, nick }), 'success');
      else this.toast(this.t('sync.upToDate', { nick }), 'success');
      if (res.failed > 0) this.toast(this.t('sync.failedN', { n: res.failed }), 'error');
    } catch (err) {
      this.toast(this.t('sync.fail', { msg: (err && err.message ? err.message : err) }), 'error');
    } finally {
      this.syncBusy = false;
      this.#setBusy(false);
      this.hideScanIndicator();
      this.#hideRowProgress(info.serial);
      if (this.syncQueued) { const next = this.syncQueued; this.syncQueued = null; this.#scanAndSync(next); }
    }
  }

  /** Acionador externo: re-sincroniza em 2º plano quando a biblioteca muda e há device ativo. */
  resync() {
    if (!devicesStore.activeDevice) return;
    this.#scanAndSync({
      serial: devicesStore.activeDevice.serial, nickname: devicesStore.activeDevice.nickname, label: devicesStore.activeDevice.label,
      configured: true, syncEnabled: true,
    });
  }

  // ---- sheet ----
  /** Acionador externo: abre a central de dispositivos. */
  async open() {
    this.showingIgnored = false;
    this.classList.remove('hidden', 'closing');
    await this.renderList();
  }
  close() { this.closeView(this); }

  #buildDeviceEl(d) {
    this.deviceConnInfo[d.serial] = { free: d.free, size: d.size, connected: d.connected };
    const el = document.createElement('syn-device');
    el.device = d;
    el.stats = this.deviceStats[d.serial] || null;
    el.artists = this.#artists();
    el.t = this.t; el.tn = this.tn;
    return el;
  }
  async renderList() {
    const res = await window.api.devicesList();
    const devices = (res && res.devices) || [];
    const active = devices.filter((d) => !d.ignored);
    const ignored = devices.filter((d) => d.ignored);

    const list = this.#$('#deviceList');
    list.innerHTML = '';
    active.sort((a, b) => (b.connected - a.connected) ||
      (a.nickname || a.label || '').localeCompare(b.nickname || b.label || '', this.t('meta.locale')));
    for (const d of active) list.appendChild(this.#buildDeviceEl(d));

    this.#$('#deviceEmpty').classList.toggle('hidden', active.length > 0 || ignored.length > 0);

    const igList = this.#$('#ignoredList');
    igList.innerHTML = '';
    for (const d of ignored) igList.appendChild(this.#buildDeviceEl(d));
    this.#$('#toggleIgnored').classList.toggle('hidden', ignored.length === 0);
    this.#$('#toggleIgnored').textContent = this.showingIgnored ? this.t('devices.hideIgnored') : this.t('devices.showIgnored');
    igList.classList.toggle('hidden', !this.showingIgnored);

    for (const d of active) {
      if (d.connected && d.syncEnabled && !this.deviceStats[d.serial]) this.#refreshStats(d.serial);
    }
  }

  /** Acionador externo (boot): restaura o contexto de badges (último device configurado). */
  async initContext() {
    try {
      const res = await window.api.devicesList();
      const devices = (res && res.devices) || [];
      if (!devices.length) return;
      const ref = devices.find((d) => d.connected && d.configured) || devices.find((d) => d.configured) || null;
      if (!ref) return;
      const st = await window.api.deviceSyncState(ref.serial);
      devicesStore.setSyncedKeys((st && st.keys) || []);
      devicesStore.setHasSyncContext(true);
      if (ref.connected) devicesStore.setActiveDevice({ serial: ref.serial, nickname: ref.nickname, label: ref.label });
      this.#refreshLibrary();
    } catch { /* sem contexto */ }
  }
}
customElements.define('syn-devices', SynDevices);

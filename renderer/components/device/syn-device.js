// <syn-device> — linha do centro de dispositivos (categoria 'device', arquétipo C-ish).
// Decisão: renderiza em LIGHT DOM (createRenderRoot → this) p/ reaproveitar a CSS global
// (.dv-*/.cap-*/.chip/.seg/.device-*) e os helpers por-serial do renderer (paintCapacityRow/
// updateDeviceRowProgress querem `.device-row[data-serial] .device-progress` — o host vira
// .device-row e os filhos são light → seguem funcionando). Ganho: template reativo + intents
// padronizados no lugar do buildDeviceRow imperativo, SEM reimplementar CSS nem a orquestração.
//
// É VIEW: toda a lógica (scan/sync/persist) fica no renderer, acionada pelos eventos:
//   syn:device:nick / :sync-toggle / :scope / :ignore / :sync-now  (bubbles+composed)
// Tempo real: o renderer atualiza o progresso pelos helpers existentes (host = .device-row).
import { LitElement, html } from 'lit';
import { fmtBytes, normPart } from '../../modules/format.js';

export class SynDevice extends LitElement {
  static properties = {
    device: { attribute: false },           // objeto d (serial, nickname, connected, free, size, syncEnabled, syncScope, ignored, drive, label, ...)
    stats: { attribute: false },            // { pendingCount, pendingBytes } | null
    artists: { attribute: false },          // [[key, disp]] (libraryArtists())
    t: { attribute: false },                // função t(key, vars) injetada
    tn: { attribute: false },               // função tn(key, n) injetada
    _scope: { state: true },                // { mode:'all'|'artists', artists:string[] } local
  };

  // light DOM: usa a CSS global do app (sem shadow)
  createRenderRoot() { return this; }

  constructor() {
    super();
    this.device = null;
    this.stats = null;
    this.artists = [];
    this.t = (k) => k;
    this.tn = (k) => k;
    this._scope = { mode: 'all', artists: [] };
  }

  #tr(k, vars) { return this.t ? this.t(k, vars) : k; }
  #emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail }));
  }

  willUpdate(changed) {
    if (changed.has('device') && this.device) {
      const sc = this.device.syncScope;
      this._scope = (sc && sc.mode === 'artists')
        ? { mode: 'artists', artists: (sc.artists || []).slice() }
        : { mode: 'all', artists: (sc && sc.artists) ? sc.artists.slice() : [] };
    }
  }

  updated() {
    // host como .device-row[data-serial] → CSS global + helpers por-serial do renderer.
    const d = this.device || {};
    this.classList.add('device-row');
    this.classList.toggle('connected', !!d.connected);
    if (d.serial) this.dataset.serial = d.serial;
  }

  #setMode(mode) {
    if (this._scope.mode === mode) return;
    if (mode === 'artists' && !this._scope.artists.length) {
      this._scope = { mode, artists: this.artists.map(([k]) => k) }; // começa com todos
    } else {
      this._scope = { ...this._scope, mode };
    }
    this.#emit('syn:device:scope', { serial: this.device.serial, scope: this._scope });
  }
  #toggleArtist(key) {
    const sel = new Set(this._scope.artists.map((a) => normPart(a)));
    if (sel.has(key)) sel.delete(key); else sel.add(key);
    this._scope = { mode: 'artists', artists: [...sel] };
    this.#emit('syn:device:scope', { serial: this.device.serial, scope: this._scope });
  }

  // ---- capacidade (espelha paintCapacity) ----
  #capacity(d) {
    const size = d.size || 0, free = d.free || 0;
    const used = Math.max(0, size - free);
    const pend = this.stats ? (this.stats.pendingBytes || 0) : null;
    const usedPct = size ? (used / size) * 100 : 0;
    const pendPct = size ? (Math.min(pend || 0, free) / size) * 100 : 0;
    let txt = this.#tr('devices.freeOf', { free: fmtBytes(free), size: fmtBytes(size) });
    let warn = false;
    if (pend == null) txt += this.#tr('devices.calculating');
    else if (pend > 0) {
      txt += this.#tr('devices.missing', { bytes: fmtBytes(pend) }) +
        (this.stats.pendingCount ? this.#tr('devices.missingTracks', { tracks: this.tn('count.track', this.stats.pendingCount) }) : '');
      if (pend > free) warn = true;
    } else txt += this.#tr('devices.upToDateCap');
    return html`
      <div class="device-capacity">
        <div class="cap-bar"><div class="cap-used" style="width:${usedPct}%"></div><div class="cap-pending" style="width:${pendPct}%"></div></div>
        <div class="cap-label ${warn ? 'warn-text' : ''}">${txt}</div>
      </div>`;
  }

  render() {
    const d = this.device;
    if (!d) return html``;
    const sc = this._scope;
    const sel = new Set(sc.artists.map((a) => normPart(a)));
    const metaParts = [];
    if (d.connected && d.drive) metaParts.push(this.#tr('devices.drive', { d: d.drive }));
    if (d.label) metaParts.push(d.label);
    metaParts.push(d.connected ? this.#tr('devices.connectedLower') : this.#tr('devices.disconnectedLower'));

    return html`
      <div class="dv-card-head">
        <div class="dv-icon" title=${d.connected ? this.#tr('devices.connected') : this.#tr('devices.disconnected')}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/></svg>
          <i class="dv-dot"></i>
        </div>
        <div class="dv-id">
          <input class="dv-nick" type="text" .value=${d.nickname || ''} placeholder=${this.#tr('devices.nickPlaceholder')} title=${this.#tr('devices.nickTitle')}
            @change=${(e) => this.#emit('syn:device:nick', { serial: d.serial, nickname: e.target.value })}
            @keydown=${(e) => { if (e.key === 'Enter') e.target.blur(); }} />
          <div class="dv-meta">${metaParts.join(' · ')}${d.usedVolumeFallback ? html`<span class="warn" title=${this.#tr('devices.volumeWarn')}> ⚠</span>` : ''}</div>
        </div>
        <div class="dv-sync" title=${this.#tr('devices.syncTitle')}>
          <label class="switch"><input type="checkbox" .checked=${!!d.syncEnabled}
            @change=${(e) => this.#emit('syn:device:sync-toggle', { serial: d.serial, enabled: e.target.checked, connected: d.connected, nickname: d.nickname, label: d.label })} /><span class="track"></span></label>
          <small>${this.#tr('devices.syncLabel')}</small>
        </div>
      </div>

      ${d.connected ? this.#capacity(d) : ''}

      ${d.syncEnabled ? html`
        <div class="dv-scope">
          <span class="dv-scope-lbl">${this.#tr('devices.whatToTake')}</span>
          <div class="seg">
            <button type="button" class="seg-opt ${sc.mode === 'all' ? 'active' : ''}" @click=${() => this.#setMode('all')}>${this.#tr('devices.all')}</button>
            <button type="button" class="seg-opt ${sc.mode === 'artists' ? 'active' : ''}" @click=${() => this.#setMode('artists')}>${this.#tr('devices.artists')}</button>
          </div>
        </div>
        <div class="scope-artists ${sc.mode === 'artists' ? '' : 'hidden'}">
          ${sc.mode === 'artists'
            ? (this.artists.length
                ? this.artists.map(([key, disp]) => html`<button type="button" class="chip ${sel.has(key) ? 'on' : ''}" @click=${() => this.#toggleArtist(key)}>${disp}</button>`)
                : html`<div class="scope-empty">${this.#tr('devices.noArtists')}</div>`)
            : ''}
        </div>` : ''}

      <div class="device-progress hidden"><div class="dp-bar"><div></div></div><div class="dp-text"></div></div>

      <div class="dv-foot">
        <button type="button" class="dv-ignore" @click=${() => this.#emit('syn:device:ignore', { serial: d.serial, ignored: !d.ignored })}>${d.ignored ? this.#tr('devices.restore') : this.#tr('devices.ignore')}</button>
        ${d.syncEnabled && d.connected ? html`
          <button type="button" class="dv-sync-now" @click=${() => this.#emit('syn:device:sync-now', { serial: d.serial, nickname: d.nickname, label: d.label })}>
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
            <span>${this.#tr('devices.syncNow')}</span>
          </button>` : ''}
      </div>
    `;
  }
}

customElements.define('syn-device', SynDevice);

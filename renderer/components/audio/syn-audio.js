// <syn-audio> — grafo Web Audio (headless) + Equalizador. Controller montado uma vez
// (<syn-audio> vazio); dono do AudioContext/AnalyserNode/cadeia de EQ e do painel #eqPanel
// (por id). Expõe `analyser`/`freqData` p/ os visualizadores (que vivem no renderer/now-playing)
// e `ensureGraph()` p/ o engine (chamar dentro do gesto do usuário).
//
// FRÁGIL: createMediaElementSource(audio) só pode rodar 1× por elemento → ensureGraph é
// idempotente (early-return se já criado). Injetados: audio (<audio> real), t, toast,
// blockedDuringLyricsEdit. Persiste em config.json (eq/eqPresets). EQ bare = ilha <syn-eq>.
import { EQ_BANDS, EQ_BUILTINS } from '../../modules/constants.js';
import '../panel/syn-eq.js';

export class SynAudio extends HTMLElement {
  constructor() {
    super();
    this.audio = null;
    this.t = (k) => k;
    this.toast = () => {};
    this.blockedDuringLyricsEdit = () => false;
    // grafo
    this.audioCtx = null; this.sourceNode = null; this.analyser = null; this.freqData = null;
    this.eqFilters = null;
    // estado EQ
    this.eqGains = [0, 0, 0, 0, 0, 0];
    this.eqEnabled = false;
    this.eqPresets = [];
    this._litEq = null;
    this._persistTimer = null;
    this._wired = false;
  }

  #g(id) { return document.getElementById(id); }

  connectedCallback() {
    if (this._wired) return;
    this._wired = true;
    this.#g('eqBtn').addEventListener('click', () => this.togglePanel());
    this.#g('eqClose').addEventListener('click', () => this.closePanel());
    this.#g('eqEnabled').addEventListener('change', () => { this.eqEnabled = this.#g('eqEnabled').checked; this.applyEq(); this.#persist(); });
    this.#g('eqFlat').addEventListener('click', () => this.loadPreset([0, 0, 0, 0, 0, 0], false));
    this.#g('eqPreset').addEventListener('change', () => {
      const v = this.#g('eqPreset').value;
      if (!v) return;
      const p = v[0] === 'b' ? EQ_BUILTINS[+v.slice(1)] : this.eqPresets[+v.slice(1)];
      if (p) { this.loadPreset(p.gains, true); this.#g('eqName').value = p.builtin ? '' : p.name; }
    });
    this.#g('eqSave').addEventListener('click', async () => {
      const name = this.#g('eqName').value.trim();
      if (!name) { this.toast(this.t('eq.nameRequired'), 'error'); return; }
      const idx = this.eqPresets.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
      const entry = { name, gains: this.eqGains.slice() };
      if (idx >= 0) this.eqPresets[idx] = entry; else this.eqPresets.push(entry);
      await window.api.setConfig({ eqPresets: this.eqPresets });
      this.#renderPresetOptions();
      this.toast(this.t('eq.presetSaved'), 'success');
    });
    this.#g('eqDelete').addEventListener('click', async () => {
      const v = this.#g('eqPreset').value;
      if (v[0] !== 'u') { this.toast(this.t('eq.selectOwnPreset'), 'error'); return; }
      this.eqPresets.splice(+v.slice(1), 1);
      await window.api.setConfig({ eqPresets: this.eqPresets });
      this.#renderPresetOptions();
      this.#g('eqName').value = '';
      this.toast(this.t('eq.presetDeleted'), 'success');
    });
  }

  // ---- grafo Web Audio (idempotente; cria a fonte 1×) ----
  ensureGraph() {
    if (this.analyser) { if (this.audioCtx.state === 'suspended') this.audioCtx.resume(); return; }
    try {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      this.sourceNode = this.audioCtx.createMediaElementSource(this.audio);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 128;               // 64 bins
      this.analyser.smoothingTimeConstant = 0.82;
      this.eqFilters = EQ_BANDS.map((b) => {
        const flt = this.audioCtx.createBiquadFilter();
        flt.type = b.type;
        flt.frequency.value = b.f;
        if (b.type === 'peaking') flt.Q.value = 1.0;
        flt.gain.value = 0;
        return flt;
      });
      let node = this.sourceNode;
      for (const flt of this.eqFilters) { node.connect(flt); node = flt; }
      node.connect(this.analyser);
      this.analyser.connect(this.audioCtx.destination);
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
      this.applyEq();
      this.audioCtx.resume();
    } catch { this.analyser = null; }
  }

  // ---- EQ ----
  applyEq() {
    if (!this.eqFilters) return;
    this.eqFilters.forEach((flt, i) => { flt.gain.value = this.eqEnabled ? (this.eqGains[i] || 0) : 0; });
  }
  updateEqBtn() {
    const on = this.eqEnabled && this.eqGains.some((g) => g !== 0);
    this.#g('eqBtn').classList.toggle('active', on);
    this.#g('npEqBtn').classList.toggle('active', on);
  }
  #persist() {
    this.updateEqBtn();
    clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => { window.api.setConfig({ eq: { enabled: this.eqEnabled, gains: this.eqGains } }); }, 300);
  }
  #ensureLitEq() {
    if (this._litEq) return;
    const box = this.#g('eqBands');
    if (!box) return;
    box.innerHTML = '';
    box.style.display = 'block'; // syn-eq (item único) preenche
    const eq = document.createElement('syn-eq');
    eq.bare = true; // só as 6 bandas; título/toggle/zerar/presets ficam no painel
    eq.addEventListener('syn:eq:change', (e) => {
      this.eqGains = e.detail.gains.slice();
      if (!this.eqEnabled && this.eqGains.some((g) => g !== 0)) { this.eqEnabled = true; this.#g('eqEnabled').checked = true; this.applyEq(); }
      this.applyEq();
      this.#persist();
    });
    box.appendChild(eq);
    this._litEq = eq;
  }
  #syncLitEq() { if (this._litEq) { this._litEq.gains = this.eqGains.slice(); this._litEq.enabled = this.eqEnabled; } }
  #renderPresetOptions() {
    const sel = this.#g('eqPreset');
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = ''; def.textContent = this.t('eq.presets');
    sel.appendChild(def);
    const og1 = document.createElement('optgroup');
    og1.label = this.t('eq.builtinGroup');
    EQ_BUILTINS.forEach((p, i) => { const o = document.createElement('option'); o.value = 'b' + i; o.textContent = this.t(p.nameKey); og1.appendChild(o); });
    sel.appendChild(og1);
    if (this.eqPresets.length) {
      const og2 = document.createElement('optgroup');
      og2.label = this.t('eq.myPresetsGroup');
      this.eqPresets.forEach((p, i) => { const o = document.createElement('option'); o.value = 'u' + i; o.textContent = p.name; og2.appendChild(o); });
      sel.appendChild(og2);
    }
  }
  loadPreset(gains, enable) {
    this.eqGains = gains.slice(0, 6).map((n) => Math.max(-12, Math.min(12, parseInt(n, 10) || 0)));
    while (this.eqGains.length < 6) this.eqGains.push(0);
    if (enable) { this.eqEnabled = true; this.#g('eqEnabled').checked = true; }
    this.applyEq();
    this.#syncLitEq();
    this.#persist();
  }

  /** Acionador externo (eqBtn/mini-player). */
  togglePanel() {
    if (this.blockedDuringLyricsEdit()) return;
    const p = this.#g('eqPanel');
    p.classList.remove('np-mode');
    p.classList.toggle('hidden');
    if (!p.classList.contains('hidden')) {
      this.#g('queuePanel').classList.add('hidden');
      this.#ensureLitEq(); this.#syncLitEq();
      this.#renderPresetOptions();
    }
  }
  closePanel() { const p = this.#g('eqPanel'); p.classList.add('hidden'); p.classList.remove('np-mode'); }
  /** Acionador externo (npEqBtn): abre o EQ no modo Now Playing. */
  openNpPanel() {
    const p = this.#g('eqPanel');
    p.classList.remove('hidden', 'closing');
    p.classList.add('np-mode');
    this.#ensureLitEq(); this.#syncLitEq(); this.#renderPresetOptions();
  }

  /** Acionador externo (boot): carrega EQ/presets do config. */
  async initEq() {
    try {
      const cfg = await window.api.getConfig();
      if (cfg.eq && Array.isArray(cfg.eq.gains) && cfg.eq.gains.length === 6) {
        this.eqGains = cfg.eq.gains.map((n) => Math.max(-12, Math.min(12, parseInt(n, 10) || 0)));
      }
      this.eqEnabled = !!(cfg.eq && cfg.eq.enabled);
      if (Array.isArray(cfg.eqPresets)) this.eqPresets = cfg.eqPresets.filter((p) => p && p.name && Array.isArray(p.gains));
    } catch { /* padrões */ }
    this.#g('eqEnabled').checked = this.eqEnabled;
    this.updateEqBtn();
    this.applyEq(); // filtros podem ainda não existir; reaplica ao criar o grafo
  }
}
customElements.define('syn-audio', SynAudio);

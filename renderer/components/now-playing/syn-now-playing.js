// <syn-now-playing> — tela cheia imersiva do player (ARCHITECTURE-V2). Controller montado
// uma vez (<syn-now-playing> vazio); OWNS por id #nowPlaying + seus botões/painéis. Dona do
// SHELL: lifecycle (open/close), modo ocioso (idle), tela cheia, painéis (EQ/fila), transporte
// (delegado ao playerStore) e META/BOTÕES REATIVOS (assina o playerStore — fonte única).
//
// O HOT-PATH (anel do espectro + karaokê) segue no renderer/ilhas (syn-visualizer/syn-lyrics):
// a NP só EMITE intents (syn:np:opened/closed/lyrics-toggle/chords-action/queue-toggle/eq-open)
// que o renderer executa. Injetados: t, blockedDuringLyricsEdit, closeView.
import { ICONS } from '../../modules/icons.js';
import { playerStore } from '../../services/core-store.js';

const NP_IDLE_MS = 3200;

function rangeFill(el) {
  if (!el) return;
  const min = parseFloat(el.min) || 0, max = parseFloat(el.max), v = parseFloat(el.value) || 0;
  el.style.setProperty('--fill', ((isFinite(max) && max > min) ? ((v - min) / (max - min)) * 100 : 0) + '%');
}

export class SynNowPlaying extends HTMLElement {
  constructor() {
    super();
    this.t = (k) => k;
    this.blockedDuringLyricsEdit = () => false;
    this.closeView = (el) => el.classList.add('hidden');
    this._wired = false;
    this._fullscreen = false;
    this._idleTimer = null;
    this._unsub = null;
  }

  #g(id) { return document.getElementById(id); }
  #tr(k) { return this.t ? this.t(k) : k; }
  #emit(name, detail) { document.dispatchEvent(new CustomEvent(name, { detail })); }
  #el() { return this.#g('nowPlaying'); }

  connectedCallback() {
    if (this._wired) return;
    this._wired = true;
    this.#wireButtons();
    this.#wireIdle();
    // assina o estado de reprodução (fonte única) → meta/botões reativos
    this._unsub = playerStore.onChange(() => this.#syncControls());
    this.#applyStaticIcons();
  }
  disconnectedCallback() { if (this._unsub) this._unsub(); }

  // ---------- lifecycle ----------
  isOpen() { return !this.#el().classList.contains('hidden'); }

  open() {
    if (!playerStore.current) return;
    if (this.blockedDuringLyricsEdit()) return;
    const np = this.#el();
    np.classList.remove('hidden', 'closing');
    this.#syncControls();
    this.#g('npVol').value = String(playerStore.volume ?? 1);
    rangeFill(this.#g('npSeek')); rangeFill(this.#g('npVol'));
    this.#emit('syn:np:opened'); // renderer: viz + karaokê + chords-btn
    this.#scheduleIdle();
  }

  close() {
    this.closeView(this.#el());
    this.hidePanels();
    this.#emit('syn:np:closed'); // renderer: para viz + ilha de letra
    this.#stopIdle();
    if (this._fullscreen) this.toggleFullscreen(); // sai da tela cheia ao recolher
  }

  // ---------- modo ocioso ----------
  #wireIdle() {
    this._onWake = () => this.#wake();
    this._onSleep = () => this.#sleepNow();
    document.addEventListener('mousemove', this._onWake);
    document.documentElement.addEventListener('mouseleave', this._onSleep);
    document.documentElement.addEventListener('mouseenter', this._onWake);
    window.addEventListener('blur', this._onSleep);
    window.addEventListener('focus', this._onWake);
  }
  #scheduleIdle() {
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => { if (this.isOpen() && !this.panelOpen()) this.#el().classList.add('idle'); }, NP_IDLE_MS);
  }
  #stopIdle() { clearTimeout(this._idleTimer); this.#el().classList.remove('idle'); }
  #wake() { if (!this.isOpen()) return; this.#el().classList.remove('idle'); this.#scheduleIdle(); }
  #sleepNow() { if (this.isOpen() && !this.panelOpen()) { clearTimeout(this._idleTimer); this.#el().classList.add('idle'); } }

  // ---------- tela cheia ----------
  isFullscreen() { return this._fullscreen; }
  async toggleFullscreen() {
    this._fullscreen = await window.api.toggleFullscreen();
    this.#el().classList.toggle('np-fs', this._fullscreen);
    const b = this.#g('npFullscreen');
    b.innerHTML = this._fullscreen ? ICONS.minimize : ICONS.maximize;
    b.title = this._fullscreen ? this.#tr('player.exitFullscreen') : this.#tr('player.fullscreen');
    setTimeout(() => { if (this.isOpen()) this.#emit('syn:np:resize'); }, 120); // recalcula o anel
  }

  // ---------- painéis imersivos (EQ / fila) ----------
  panelOpen() {
    return ['eqPanel', 'queuePanel'].some((id) => {
      const p = this.#g(id);
      return p.classList.contains('np-mode') && !p.classList.contains('hidden');
    });
  }
  hidePanels() {
    for (const id of ['eqPanel', 'queuePanel']) {
      this.#g(id).classList.add('hidden');
      this.#g(id).classList.remove('np-mode');
    }
    if (this.isOpen()) this.#scheduleIdle();
  }

  // ---------- karaokê (estado do shell; render no renderer/ilha) ----------
  isLyricsMode() { return this.#el().classList.contains('lyrics-mode'); }
  setLyricsMode(on) {
    this.#el().classList.toggle('lyrics-mode', on);
    this.#g('npLyricsBtn').classList.toggle('active', on);
    this.#emit('syn:np:lyrics-toggle', { on }); // renderer: render karaokê + chords-btn
  }

  // ---------- wiring dos botões ----------
  #wireButtons() {
    const p = playerStore;
    this.#g('npCollapse').addEventListener('click', () => this.close());
    this.#g('npPlay').addEventListener('click', () => p.toggle());
    this.#g('npPrev').addEventListener('click', () => p.prev());
    this.#g('npNext').addEventListener('click', () => p.next());
    this.#g('npShuffle').addEventListener('click', () => p.toggleShuffle());
    this.#g('npRepeat').addEventListener('click', () => p.cycleRepeat());
    this.#g('npFullscreen').addEventListener('click', () => this.toggleFullscreen());
    this.#g('npSeek').addEventListener('input', (e) => p.seekFraction(parseInt(e.target.value, 10) / 1000));
    this.#g('npVol').addEventListener('input', (e) => { p.setVolume(parseFloat(e.target.value)); rangeFill(e.target); });
    this.#g('npLyricsBtn').addEventListener('click', () => this.setLyricsMode(!this.isLyricsMode()));
    this.#g('npChordsBtn').addEventListener('click', () => this.#emit('syn:np:chords-action'));
    this.#g('npQueueBtn').addEventListener('click', () => {
      const panel = this.#g('queuePanel');
      const show = panel.classList.contains('hidden');
      this.hidePanels();
      if (show) { panel.classList.remove('hidden', 'closing'); panel.classList.add('np-mode'); this.#emit('syn:np:queue-render'); }
    });
    this.#g('npEqBtn').addEventListener('click', () => {
      const show = this.#g('eqPanel').classList.contains('hidden');
      this.hidePanels();
      if (show) this.#emit('syn:np:eq-open');
    });
  }

  // ícones estáticos dos botões (os dinâmicos são geridos por #syncControls)
  #applyStaticIcons() {
    this.#g('npCollapse').innerHTML = ICONS.chevronDown;
    this.#g('npLyricsBtn').innerHTML = ICONS.lyrics;
    this.#g('npFullscreen').innerHTML = ICONS.maximize;
    this.#g('npQueueBtn').innerHTML = ICONS.queue;
    this.#g('npEqBtn').innerHTML = ICONS.eq;
    this.#g('npShuffle').innerHTML = ICONS.shuffle;
    this.#g('npPrev').innerHTML = ICONS.prev;
    this.#g('npNext').innerHTML = ICONS.next;
    this.#g('npVolIcon').innerHTML = ICONS.volume;
  }

  // ---------- meta + botões reativos (assina o playerStore) ----------
  #syncControls() {
    const p = playerStore;
    const cur = p.current;
    const title = cur ? (p.title || cur.title || (cur.fileName || '').replace(/\.mp3$/i, '') || '—') : '—';
    this.#g('npTitle').textContent = title;
    this.#g('npArtist').textContent = (cur && (p.artist || cur.artist)) || '';
    this.#setCover(p.coverUrl);
    this.#g('npPlay').innerHTML = p.isPlaying ? ICONS.pause : ICONS.play;
    this.#g('npShuffle').classList.toggle('active', !!p.shuffle);
    const rb = this.#g('npRepeat');
    rb.innerHTML = p.repeatMode === 'one' ? ICONS.repeatOne : ICONS.repeat;
    rb.classList.toggle('active', p.repeatMode !== 'off');
    rb.title = p.repeatMode === 'one' ? this.#tr('player.repeatTrack') : (p.repeatMode === 'all' ? this.#tr('player.repeatQueue') : this.#tr('player.repeat'));
    const vol = this.#g('npVol');
    if (vol && document.activeElement !== vol) { vol.value = String(p.volume ?? 1); rangeFill(vol); }
  }
  #setCover(url) {
    const c = this.#g('npCover');
    if (!url) { c.innerHTML = '<span class="ph">♪</span>'; return; }
    const img = document.createElement('img');
    img.alt = '';
    img.onerror = () => { c.innerHTML = '<span class="ph">♪</span>'; };
    img.src = url;
    c.innerHTML = ''; c.appendChild(img);
  }
}
customElements.define('syn-now-playing', SynNowPlaying);

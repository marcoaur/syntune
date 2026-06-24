// <syn-visualizer> — anel circular de espectro da Now Playing (categoria 'panel', Fase E).
// HOT-PATH (§1.6 / §4): desenha no canvas via RafController; NUNCA re-render por frame.
// Pausa quando inativo (oculto/parado) — economia + reduced-motion. Light-DOM (host
// display:contents) → o <canvas class="np-viz"> herda o posicionamento da CSS global em .np-art.
//
// Recebe por propriedade (a engine de áudio/paleta vive no renderer): `analyser`+`freqData`
// (AnalyserNode compartilhado), `coverEl` (o anel acompanha o tamanho da capa), `palette`
// ({r,g,b} alvo, interpolada suave aqui) e `active` (toca && NP aberta).
import { LitElement, html } from 'lit';
import { lerpPal, deriveBarColors } from '../../modules/color.js';

const BARS = 84;
const DEFAULT_PAL = { r: 124, g: 92, b: 255, text: '#ffffff' };

export class SynVisualizer extends LitElement {
  static properties = {
    analyser: { attribute: false },
    freqData: { attribute: false },
    coverEl: { attribute: false },
    palette: { attribute: false },
    active: { type: Boolean },
  };

  // light DOM: o <canvas class="np-viz"> herda o posicionamento absoluto da CSS global,
  // resolvido contra .np-art. O host não deve criar bloco de contenção → display:contents.
  createRenderRoot() { return this; }
  connectedCallback() { super.connectedCallback(); this.style.display = 'contents'; }

  constructor() {
    super();
    this.analyser = null;
    this.freqData = null;
    this.coverEl = null;
    this.palette = null;
    this.active = false;
    this._cur = { ...DEFAULT_PAL };
    this._raf = new RafControllerLocal(this, () => this.#draw());
    this._reduce = false;
    try { this._reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* ok */ }
  }

  get #canvas() { return this.querySelector('canvas.np-viz'); }

  updated() {
    // liga/desliga o loop conforme `active` + analyser disponível.
    // (reduced-motion: o anel é ambiente; o legado sempre desenhava — mantemos pra paridade)
    if (this.active && this.analyser && this.freqData) {
      this.#size();
      this._raf.start();
    } else {
      this._raf.stop();
      const cv = this.#canvas; // limpa ao parar
      if (cv) { const c = cv.getContext('2d'); if (c) c.clearRect(0, 0, cv.width, cv.height); }
    }
  }

  #size() {
    const cv = this.#canvas;
    if (!cv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const css = Math.min(window.innerHeight * 0.92, window.innerWidth * 0.95);
    cv.style.width = css + 'px'; cv.style.height = css + 'px';
    cv.width = Math.round(css * dpr); cv.height = Math.round(css * dpr);
  }

  #draw() {
    const cv = this.#canvas;
    if (!cv || !this.analyser) { this._raf.stop(); return; }
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height, cx = w / 2, cy = h / 2;
    ctx.clearRect(0, 0, w, h);
    this.analyser.getByteFrequencyData(this.freqData);

    // o anel acompanha o TAMANHO ATUAL DA CAPA (zoom ocioso / tela cheia)
    const coverRect = this.coverEl ? this.coverEl.getBoundingClientRect() : { width: 320 };
    const cvRect = cv.getBoundingClientRect();
    const pxScale = cvRect.width ? (w / cvRect.width) : 1;
    const coverR = Math.max(40, (coverRect.width / 2) * pxScale);
    const baseR = coverR * 1.06;
    const maxLen = coverR * 0.62;

    const bins = this.freqData.length;
    this._cur = lerpPal(this._cur, this.palette || DEFAULT_PAL, 0.09);
    const colors = deriveBarColors(this._cur);
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(2, coverR * 0.03);
    ctx.shadowBlur = coverR * 0.08;
    for (let i = 0; i < BARS; i++) {
      const half = i < BARS / 2 ? i : (BARS - 1 - i); // espelha o espectro → anel simétrico
      const idx = Math.floor((half / (BARS / 2)) * bins * 0.8);
      const v = (this.freqData[idx] || 0) / 255;
      const len = coverR * 0.04 + v * maxLen;
      const ang = (i / BARS) * Math.PI * 2 - Math.PI / 2;
      const x1 = cx + Math.cos(ang) * baseR, y1 = cy + Math.sin(ang) * baseR;
      const x2 = cx + Math.cos(ang) * (baseR + len), y2 = cy + Math.sin(ang) * (baseR + len);
      const grad = ctx.createLinearGradient(x1, y1, x2, y2);
      grad.addColorStop(0, colors.bottom);
      grad.addColorStop(1, colors.top);
      ctx.strokeStyle = grad;
      ctx.shadowColor = colors.top;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
  }

  render() { return html`<canvas class="np-viz" width="560" height="560"></canvas>`; }
}

// rAF mínimo (sem depender do RafController p/ manter este componente autocontido no draw)
class RafControllerLocal {
  constructor(host, tick) { this.host = host; this.tick = tick; this.id = 0; host.addController(this); }
  start() { if (this.id) return; const loop = () => { this.tick(); this.id = requestAnimationFrame(loop); }; this.id = requestAnimationFrame(loop); }
  stop() { if (this.id) cancelAnimationFrame(this.id); this.id = 0; }
  hostDisconnected() { this.stop(); }
}

customElements.define('syn-visualizer', SynVisualizer);

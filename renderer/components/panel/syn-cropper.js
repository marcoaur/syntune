// <syn-cropper> — recorte de capa (categoria 'panel'). Pan + zoom em janela quadrada,
// saída JPEG. Replica o math do cropper legado (coverScale/scale/tx/ty; CROP_BOX→CROP_OUT).
// Aplica a tática (compõe folha): syn-range controla o zoom. A "engrenagem é dele": dada a
// `src`, ele carrega, enquadra, deixa arrastar/zoom (mouse, roda, TECLADO p/ a11y §3.1) e
// devolve o recorte. Emite syn:cover:crop {dataUrl} (aplicar) / syn:cover:cancel.
//
// Hot-path §1.6: o transform do <img> é escrito DIRETO no style (pan/zoom), sem re-render.
import { html, css } from 'lit';
import { SyntuneElement } from '../base/syntune-element.js';
import '../control/syn-range.js';

const CROP_BOX = 300; // px da janela de preview
const CROP_OUT = 640; // px do lado da imagem final
const PAN_STEP = 12;  // px por seta (teclado)

export class SynCropper extends SyntuneElement {
  static category = 'panel';

  static properties = {
    src: { type: String },
    applyLabel: { type: String },
    cancelLabel: { type: String },
  };

  static styles = [
    ...SyntuneElement.styles,
    css`
      :host { display: block; }
      .stage {
        position: relative; width: ${CROP_BOX}px; height: ${CROP_BOX}px; margin: 0 auto;
        overflow: hidden; border-radius: var(--syn-radius); background: #000; cursor: grab;
        touch-action: none;
      }
      .stage:active { cursor: grabbing; }
      .stage:focus-visible { outline: 2px solid rgb(var(--syn-accent)); outline-offset: 2px; }
      .crop-img { position: absolute; top: 0; left: 0; transform-origin: 0 0; user-select: none; pointer-events: none; }
      .grid { position: absolute; inset: 0; pointer-events: none;
              background-image: linear-gradient(rgba(255,255,255,.25) 1px, transparent 1px),
                                linear-gradient(90deg, rgba(255,255,255,.25) 1px, transparent 1px);
              background-size: ${CROP_BOX / 3}px ${CROP_BOX / 3}px; }
      .zoom-row { display: flex; align-items: center; gap: 10px; margin: 14px 0 4px; }
      .zoom-row syn-range { flex: 1; }
      .zoom-btn {
        appearance: none; border: 0; cursor: pointer; width: 28px; height: 28px; flex: none;
        border-radius: 50%; font: 700 16px/1 var(--syn-font); color: var(--syn-fg);
        background: rgba(var(--syn-accent), 0.18);
      }
      .zoom-btn:hover { background: rgba(var(--syn-accent), 0.30); }
      .actions { display: flex; justify-content: flex-end; gap: 8px; }
      .btn { appearance: none; border: 0; cursor: pointer; font: 600 13px/1 var(--syn-font);
             border-radius: var(--syn-radius); padding: 8px 14px; color: var(--syn-fg); }
      .btn-primary { background: rgb(var(--syn-accent)); color: #fff; }
      .btn-ghost { background: rgba(127,127,127,0.18); }
    `,
  ];

  constructor() {
    super();
    this.src = '';
    this.applyLabel = 'Aplicar';
    this.cancelLabel = 'Cancelar';
    this._s = { scale: 1, coverScale: 1, tx: 0, ty: 0, nw: 0, nh: 0 };
    this._zoom = 1;
    this._drag = null;
  }

  get #img() { return this.renderRoot.querySelector('.crop-img'); }

  #clamp() {
    const s = this._s;
    s.tx = Math.min(0, Math.max(CROP_BOX - s.nw * s.scale, s.tx));
    s.ty = Math.min(0, Math.max(CROP_BOX - s.nh * s.scale, s.ty));
  }
  #paint() {
    this.#clamp();
    const s = this._s, img = this.#img;
    if (img) img.style.transform = `translate(${s.tx}px, ${s.ty}px) scale(${s.scale})`;
  }

  #onImgLoad(e) {
    const img = e.target, s = this._s;
    s.nw = img.naturalWidth; s.nh = img.naturalHeight;
    s.coverScale = Math.max(CROP_BOX / s.nw, CROP_BOX / s.nh);
    s.scale = s.coverScale;
    s.tx = (CROP_BOX - s.nw * s.scale) / 2;
    s.ty = (CROP_BOX - s.nh * s.scale) / 2;
    this._zoom = 1;
    const zr = this.renderRoot.querySelector('syn-range');
    if (zr) zr.value = 1;
    this.#paint();
  }

  // Fonte única do zoom: slider, roda, botões ＋/－ e teclado +/- chamam aqui.
  // Faz zoom em torno do centro da janela e mantém o slider em sincronia.
  #setZoom(zoom) {
    const s = this._s;
    const z = Math.min(3, Math.max(1, zoom || 1));
    this._zoom = z;
    const zr = this.renderRoot.querySelector('syn-range');
    if (zr && Number(zr.value) !== z) zr.value = z;
    const cx = CROP_BOX / 2, cy = CROP_BOX / 2;
    const imgX = (cx - s.tx) / s.scale, imgY = (cy - s.ty) / s.scale;
    s.scale = s.coverScale * z;
    s.tx = cx - imgX * s.scale; s.ty = cy - imgY * s.scale;
    this.#paint();
  }
  #zoomBy(d) { this.#setZoom(this._zoom + d); }

  #pan(dx, dy) { this._s.tx += dx; this._s.ty += dy; this.#paint(); }

  #onPointerDown(e) {
    this._drag = { x: e.clientX, y: e.clientY, tx: this._s.tx, ty: this._s.ty };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  #onPointerMove(e) {
    if (!this._drag) return;
    this._s.tx = this._drag.tx + (e.clientX - this._drag.x);
    this._s.ty = this._drag.ty + (e.clientY - this._drag.y);
    this.#paint();
  }
  #onPointerUp() { this._drag = null; }

  #onWheel(e) {
    e.preventDefault();
    this.#zoomBy(e.deltaY < 0 ? 0.06 : -0.06);
  }

  #onKey(e) {
    const k = e.key;
    if (k === 'ArrowLeft') { this.#pan(PAN_STEP, 0); e.preventDefault(); }
    else if (k === 'ArrowRight') { this.#pan(-PAN_STEP, 0); e.preventDefault(); }
    else if (k === 'ArrowUp') { this.#pan(0, PAN_STEP); e.preventDefault(); }
    else if (k === 'ArrowDown') { this.#pan(0, -PAN_STEP); e.preventDefault(); }
    else if (k === '+' || k === '=') { this.#zoomBy(0.2); e.preventDefault(); }
    else if (k === '-' || k === '_') { this.#zoomBy(-0.2); e.preventDefault(); }
  }

  #apply() {
    const s = this._s, img = this.#img;
    if (!img) return;
    const canvas = document.createElement('canvas');
    canvas.width = CROP_OUT; canvas.height = CROP_OUT;
    const ctx = canvas.getContext('2d');
    const sBox = CROP_BOX / s.scale;
    ctx.drawImage(img, -s.tx / s.scale, -s.ty / s.scale, sBox, sBox, 0, 0, CROP_OUT, CROP_OUT);
    this.emit('syn:cover:crop', { dataUrl: canvas.toDataURL('image/jpeg', 0.92) });
  }

  render() {
    return html`
      <div
        class="stage" tabindex="0" role="img" aria-label="Enquadrar capa (arraste ou use as setas; roda = zoom)"
        @pointerdown=${(e) => this.#onPointerDown(e)}
        @pointermove=${(e) => this.#onPointerMove(e)}
        @pointerup=${() => this.#onPointerUp()}
        @pointercancel=${() => this.#onPointerUp()}
        @wheel=${(e) => this.#onWheel(e)}
        @keydown=${(e) => this.#onKey(e)}
      >
        <img class="crop-img" src=${this.src} alt="" draggable="false" @load=${(e) => this.#onImgLoad(e)} />
        <div class="grid"></div>
      </div>
      <div class="zoom-row">
        <button class="zoom-btn" aria-label="Diminuir zoom" @click=${() => this.#zoomBy(-0.25)}>－</button>
        <syn-range
          label="Zoom" .min=${1} .max=${3} .step=${0.01} .value=${1}
          @syn:control:change=${(e) => this.#setZoom(e.detail.value)}
        ></syn-range>
        <button class="zoom-btn" aria-label="Aumentar zoom" @click=${() => this.#zoomBy(0.25)}>＋</button>
      </div>
      <div class="actions">
        <button class="btn btn-ghost" @click=${() => this.emit('syn:cover:cancel')}>${this.cancelLabel}</button>
        <button class="btn btn-primary" @click=${() => this.#apply()}>${this.applyLabel}</button>
      </div>
    `;
  }
}

customElements.define('syn-cropper', SynCropper);

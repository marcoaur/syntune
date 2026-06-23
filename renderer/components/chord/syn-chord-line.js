// <syn-chord-line> — a ilha do karaokê de acordes. Junta 3 arquétipos numa fatia vertical
// (FRONTEND-MIGRATION.md Fase 0):
//   • CONECTADO (C) — consome o PlayerService via @lit/context (tempo/seek).
//   • CONTAINER (B) — entende seus filhos `syn-chord-mark` (categoria 'chord'),
//     orquestra props down (posição/destaque) e relê/re-emite o feedback up.
//   • HOT-PATH (D) — RafController + MediaTimeController: anima sweep/cabeça/brilho
//     ESCREVENDO style direto a 60fps, SEM re-render do Lit por frame (§1.6 / §4).
//
// "A engrenagem é dele": dada a lista de acordes + a janela [start,end] + o accent, ele
// sabe se montar, se sincronizar ao tempo do player e traduzir clique→seek sozinho.
import { html, css } from 'lit';
import { ContextConsumer } from '@lit/context';
import { SyntuneElement } from '../base/syntune-element.js';
import { ContainerMixin } from '../base/container-mixin.js';
import { RafController } from '../controllers/raf-controller.js';
import { MediaTimeController } from '../controllers/media-time-controller.js';
import { playerContext } from '../../services/contexts.js';
import './syn-chord-mark.js';

// Recuo lateral da faixa útil (px): acordes em f=0/f=1 ficam visíveis sem clipping; a barra
// usa EXATAMENTE o mesmo mapa, então encosta no acorde no instante c.t. (Espelha o legado.)
const CHORD_INSET = 28;
const CHORD_GLOW_DECAY = 1.6; // s até o acorde voltar ao dim depois de alcançado

export class SynChordLine extends ContainerMixin(SyntuneElement) {
  static category = 'chord';

  static properties = {
    chords: { attribute: false }, // [{ time:Number, label:String }]
    start: { type: Number },
    end: { type: Number },
    accent: { type: String },     // rgb triplet, ex.: '150,130,255'
    // PlayerService passado por PROPRIEDADE (facade): quando a ilha é montada FORA do
    // <syn-app-root> (ex.: dentro do karaokê no #npLyrics legado) o @lit/context não
    // resolve — então o pai injeta o player aqui. Fallback p/ o context (ilha standalone).
    player: { attribute: false },
    // ativa = a varredura (sweep) + cabeça aparecem e avançam pelo tempo. Quando false,
    // o acorde ainda PULSA/decai (glow por tempo absoluto), mas a barra fica oculta —
    // espelha o legado, onde só a linha EM FOCO mostra a varredura. Default true mantém
    // a ilha de acordes standalone (Fase 0) sempre com a barra visível.
    active: { type: Boolean },
    // edição inline (advancedEdit): em modo editável o clique NÃO busca (seleção/arraste
    // são geridos pelo editor no pai); o pai usa a geometria pública (timeFromClientX/placeMark).
    editable: { type: Boolean },
  };

  static styles = [
    ...SyntuneElement.styles,
    css`
      :host {
        position: relative; display: block; height: 26px;
        /* width explícita: o conteúdo é todo position:absolute (largura intrínseca ≈ 0);
           sem isto o host colapsa quando o pai usa flex align-items:center → marks
           empilham e a barra some. max-width centraliza a régua. */
        width: 100%; max-width: 760px; margin: 0 auto;
      }
      /* varredura/cabeça entram e saem por opacidade (transição) quando a linha (des)ativa;
         a LARGURA/posição é imperativa por frame. Espelha o fade do karaokê legado. */
      .sweep {
        position: absolute; left: 0; bottom: 1px; height: 2px; width: 0; border-radius: 2px;
        background: linear-gradient(90deg, rgba(var(--syn-accent), 0), rgba(var(--syn-accent), .55));
        opacity: 1; transition: opacity .25s ease;
      }
      .head {
        position: absolute; bottom: 0; width: 5px; height: 5px; border-radius: 50%;
        transform: translateX(-50%); background: rgb(var(--syn-accent));
        box-shadow: 0 0 8px 2px rgba(var(--syn-accent), .75);
        opacity: 1; transition: opacity .25s ease;
      }
    `,
  ];

  constructor() {
    super();
    this.chords = [];
    this.start = 0;
    this.end = 1;
    this.accent = '124, 92, 255';
    this.active = true;
    this.editable = false;
    this.player = null;
    this._boundPlayer = null;

    // CONECTADO: o PlayerService chega via context (provido no <syn-app-root>).
    this._time = new MediaTimeController(this, null);
    this._player = new ContextConsumer(this, {
      context: playerContext,
      subscribe: true,
      callback: (player) => { this._time.setPlayer(player); },
    });

    // HOT-PATH: loop próprio; cada frame escreve style sem disparar render do Lit.
    this._raf = new RafController(this, () => this.#frame());

    // CONTAINER: relê o feedback dos filhos (sobe por composed) → seek + re-emite p/ cima.
    this.addEventListener('syn:chord:select', (e) => {
      // em edição o clique não busca — seleção/arraste ficam com o editor (pai).
      if (!this.editable) {
        const p = this.player || this._player.value;
        if (p && typeof p.seek === 'function') p.seek(e.detail.time + 0.02);
      }
      this.emit('syn:chordline:select', e.detail); // re-emissão padronizada pro pai
    });
    this.addEventListener('syn:chord:edit', (e) => this.emit('syn:chordline:edit', e.detail));
  }

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute('role', 'group');
    this.setAttribute('aria-label', 'Acordes sincronizados');
    this._raf.start();
  }

  // Filhos por categoria (em shadow, pois são data-driven a partir de `chords`).
  get #marks() { return [...this.renderRoot.querySelectorAll('syn-chord-mark')]; }
  get markEls() { return this.#marks; } // público p/ o editor (syn-lyrics)

  #map(f) { return `calc(${CHORD_INSET}px + ${f} * (100% - ${2 * CHORD_INSET}px))`; }
  #frac(time) {
    const span = Math.max(0.1, this.end - this.start);
    return Math.min(1, Math.max(0, (time - this.start) / span));
  }

  // --- geometria pública p/ o editor inline (advancedEdit) ---
  // tempo (s) a partir da posição X do ponteiro dentro do trilho útil (mesmo inset da barra)
  timeFromClientX(clientX) {
    const r = this.getBoundingClientRect();
    const usable = Math.max(1, r.width - 2 * CHORD_INSET);
    const f = Math.min(1, Math.max(0, (clientX - r.left - CHORD_INSET) / usable));
    return this.start + f * (this.end - this.start);
  }
  // reposiciona um mark imperativamente (arraste/nudge sem re-render)
  placeMark(markEl, time) { if (markEl) markEl.style.left = this.#map(this.#frac(time)); }

  // PROPS DOWN estáticas: posição/accent dos filhos derivam das props → em updated() (não por frame).
  updated() {
    // player por propriedade (fora do app-root): assina o tempo dele uma vez por troca.
    if (this.player && this.player !== this._boundPlayer) {
      this._boundPlayer = this.player;
      this._time.setPlayer(this.player);
    }
    this.style.setProperty('--syn-accent', this.accent);
    for (const m of this.#marks) {
      m.style.setProperty('--syn-mark-acc', this.accent);
      m.style.left = this.#map(this.#frac(m.time));
    }
  }

  // HOT-PATH por frame: barra/cabeça/brilho — só escrita de style, zero re-template.
  #frame() {
    const cur = this._time.currentTime;
    const p = this.#frac(cur);
    const sweep = this.renderRoot.querySelector('.sweep');
    const head = this.renderRoot.querySelector('.head');
    // só a linha ATIVA mostra a barra; inativa = oculta (largura 0), mas o glow segue.
    if (sweep) { sweep.style.opacity = this.active ? '1' : '0'; sweep.style.width = this.active ? this.#map(p) : '0px'; }
    if (head) { head.style.opacity = this.active ? '1' : '0'; head.style.left = this.#map(p); }
    for (const m of this.#marks) {
      const g = cur >= m.time ? Math.max(0, 1 - (cur - m.time) / CHORD_GLOW_DECAY) : 0;
      m.style.setProperty('--syn-mark-glow', g.toFixed(3));
    }
  }

  render() {
    return html`
      <div class="sweep"></div>
      <div class="head"></div>
      ${(this.chords || []).map((c) => html`
        <syn-chord-mark .label=${c.label} .time=${c.time} .src=${c.src} .editable=${this.editable}></syn-chord-mark>
      `)}
    `;
  }
}

customElements.define('syn-chord-line', SynChordLine);

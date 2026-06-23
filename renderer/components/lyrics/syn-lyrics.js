// <syn-lyrics> — o KARAOKÊ (carro-chefe, FRONTEND-MIGRATION.md Fase E). Funde:
//   • CONECTADO (C) — consome o PlayerService (tempo/seek) via @lit/context.
//   • CONTAINER (B) — entende seus filhos `syn-chord-line` (categoria 'chord'): cada
//     verso com acordes embute UMA linha de acordes com janela [verso.t, próximo.t] —
//     a folha (já testada) faz sweep/glow/glyphs; o mestre só diz qual está `active`.
//   • HOT-PATH (D) — porta o motor de rolagem com MOLA criticamente amortecida + opacidade
//     por distância + pontos de interlúdio, ESCREVENDO transform/opacity por frame, SEM
//     re-render do Lit (RafController + MediaTimeController). Espelha `lyricFrame` legado.
//
// LIGHT-DOM (`createRenderRoot` devolve `this`, `display:contents`): reusa toda a CSS
// global `.np-lyrics-*` (tática de peça muito acoplada à styles.css — ver leaf-migration).
// Vive DENTRO do `#npLyrics` (.np-lyrics-view); o renderer segue gerindo as classes do box
// (synced/chords-on/np-synced) e a var --chord-accent. A edição inline de acordes
// (advancedEdit) permanece no caminho legado — sua migração é um sub-passo posterior.
import { html, css } from 'lit';
import { ContextConsumer } from '@lit/context';
import { SyntuneElement } from '../base/syntune-element.js';
import { ContainerMixin } from '../base/container-mixin.js';
import { RafController } from '../controllers/raf-controller.js';
import { MediaTimeController } from '../controllers/media-time-controller.js';
import { playerContext } from '../../services/contexts.js';
import '../chord/syn-chord-line.js';

const KARAOKE_GAP_MIN = 3;       // intro (s): 1ª linha demora > isso → mostra os 3 pontos
const SPRING_W = 10;             // rigidez da mola (rad/s): acomoda ~0,45s sem ultrapassar

export class SynLyrics extends ContainerMixin(SyntuneElement) {
  static category = 'lyric';

  static properties = {
    // entradas cruas (props down) — o render DERIVA o modelo (idempotente §1.2):
    synced: { attribute: false },     // [{ t, text }] | null  (LRC sincronizado)
    chordsData: { attribute: false }, // [{ t, text }]          (timeline de acordes)
    showChords: { type: Boolean },    // toggle do usuário
    plain: { type: String },          // letra em texto puro (sem sincronia)
    accent: { type: String },         // triplet rgb dos acordes, ex.: '150,130,255'
    active: { type: Boolean },        // karaokê visível (NP aberta + lyrics-mode) → roda o rAF
    // PlayerService por PROPRIEDADE (facade): montado FORA do <syn-app-root> (no #npLyrics
    // legado), o @lit/context não resolve → o renderer injeta o player aqui. É repassado às
    // folhas syn-chord-line embutidas (que também ficam fora do root).
    player: { attribute: false },
    editMode: { type: Boolean },      // edição inline de acordes (advancedEdit + acordes ON)
    t: { attribute: false },          // função i18n (fallback p/ textos)
  };

  // light-DOM: sem shadow, mas registramos um estilo mínimo no host (display:contents).
  static styles = [css``];
  createRenderRoot() { return this; }

  constructor() {
    super();
    this.synced = null;
    this.chordsData = [];
    this.showChords = false;
    this.plain = '';
    this.accent = '150,130,255';
    this.active = false;
    this.player = null;
    this._boundPlayer = null;
    this.editMode = false;
    this.t = (k) => k;

    // estado do editor inline (advancedEdit): seleção + arraste + overlays (hint/input).
    this._sel = null;      // syn-chord-mark selecionado
    this._selLine = null;  // syn-chord-line dono do selecionado (geometria p/ teclado)
    this._drag = null;     // { mark, line, src, wasPlaying, moved, startX }
    this._hint = null;     // div fixa com o timestamp (criada sob demanda)
    this._hintTimer = null;
    this._suppressClick = false;
    this._onDocMove = (e) => this.#dragMove(e);
    this._onDocUp = () => this.#dragEnd();
    this._onDocKey = (e) => this.#editKey(e);

    // CONECTADO: tempo ao vivo do player (chega async via context no <syn-app-root>).
    this._time = new MediaTimeController(this, null);
    this._player = new ContextConsumer(this, {
      context: playerContext,
      subscribe: true,
      callback: (player) => { this._time.setPlayer(player); },
    });

    // HOT-PATH: loop próprio; cada frame escreve transform/opacity sem render do Lit.
    this._raf = new RafController(this, () => this.#frame());

    // estado da mola/scroll (espelha as globais np* do legado):
    this._anchors = [];   // [{ el, t, start, end, kind, chordLine?, dots? }]
    this._track = null;
    this._box = null;
    this._trackTop = 0;
    this._maxTop = 0;
    this._curTop = null;  // posição animada (null = recentra sem deslizar)
    this._vel = 0;
    this._lastTop = -1;
    this._lastTs = 0;
    this._lastCenter = null;

    this._onResize = () => { if (this.active) { this.#measure(); this._curTop = null; } };
  }

  connectedCallback() {
    super.connectedCallback();
    this.style.display = 'contents';
    this.setAttribute('role', 'list');
    this.setAttribute('aria-label', this.t('player.lyrics') || 'Letra');
    window.addEventListener('resize', this._onResize);
    // editor inline (gestos): pointerdown/dblclick no host; move/up/key no document.
    this.addEventListener('pointerdown', (e) => this.#dragStart(e));
    this.addEventListener('dblclick', (e) => this.#dblclick(e));
    // o syn-chord-mark dá stopPropagation no dblclick nativo → renomeia via evento custom.
    this.addEventListener('syn:chord:edit', (e) => {
      if (!this.editMode) return;
      const m = e.composedPath().find((el) => el.tagName === 'SYN-CHORD-MARK');
      if (m) this.#editText(m, false);
    });
    // suprime o seek-da-linha logo após um arraste (o click sintético cairia na .np-lyric).
    this.addEventListener('click', (e) => {
      if (this._suppressClick) { this._suppressClick = false; e.stopPropagation(); e.preventDefault(); }
    }, true);
    document.addEventListener('pointermove', this._onDocMove);
    document.addEventListener('pointerup', this._onDocUp);
    // keydown em CAPTURA: roda antes dos handlers globais (←/→ = faixa) → stopImmediate vence.
    document.addEventListener('keydown', this._onDocKey, true);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('pointermove', this._onDocMove);
    document.removeEventListener('pointerup', this._onDocUp);
    document.removeEventListener('keydown', this._onDocKey, true);
    this.#hideHint();
    this._raf.stop();
  }

  // ---------- modelo (deriva das props) ----------
  // Espelha a construção de `renderNpLyrics` (sem a parte de edição inline). Devolve a
  // ordem das "linhas" a renderizar; updated() zipa este modelo com os nós .np-lyric.
  #model() {
    const allChords = (this.chordsData || []).filter((c) => c.text);
    const hasChords = allChords.length > 0 && this.showChords;
    const chords = hasChords ? allChords : [];
    const synced = !!(this.synced && this.synced.length);
    const out = [];

    if (synced) {
      const vis = this.synced.filter((l) => l.text);
      // intro: acordes antes da 1ª linha ganham linha própria; senão, 3 pontos se demora > 3s
      const introChords = (hasChords && vis.length) ? chords.filter((c) => c.t < vis[0].t - 0.001) : [];
      if (vis.length && introChords.length) {
        out.push({ kind: 'chord-only', t: 0, start: 0, end: vis[0].t, chords: introChords });
      } else if (vis.length && vis[0].t > KARAOKE_GAP_MIN) {
        out.push({ kind: 'interlude', t: 0, g0: 0, g1: vis[0].t });
      }
      vis.forEach((ln, idx) => {
        const start = ln.t;
        const nextStart = (idx + 1 < vis.length) ? vis[idx + 1].t : Infinity;
        const bucket = hasChords ? chords.filter((c) => c.t >= start - 0.001 && c.t < nextStart - 0.001) : [];
        const end = (nextStart !== Infinity) ? nextStart : (bucket.length ? bucket[bucket.length - 1].t + 4 : start + 8);
        // em edição mostra a faixa de acordes mesmo VAZIA (gutter p/ duplo-clique = criar)
        const showRow = bucket.length > 0 || (this.editMode && hasChords);
        out.push({ kind: showRow ? 'verse-chords' : 'verse', t: ln.t, start, end, text: ln.text, chords: bucket });
      });
    } else if (hasChords) {
      // instrumental: acordes em grupos de 4, espalhados no tempo do grupo
      const sorted = chords.slice().sort((a, b) => a.t - b.t);
      const groups = [];
      for (let i = 0; i < sorted.length; i += 4) groups.push(sorted.slice(i, i + 4));
      groups.forEach((g, gi) => {
        const start = g[0].t;
        const end = (gi + 1 < groups.length) ? groups[gi + 1][0].t : (g[g.length - 1].t + 4);
        out.push({ kind: 'chord-only', t: start, start, end, chords: g });
      });
    }
    return { rows: out, synced, hasChords };
  }

  // acordes {t,text} → {time,label,src} (src = ref opaca p/ o editor mutar o estado)
  #toMarks(list) { return (list || []).map((c) => ({ time: c.t, label: c.text, src: c })); }

  #seekLine(t) {
    const p = this.player || this._player.value;
    if (p && typeof p.seek === 'function') p.seek(t + 0.02);
  }

  render() {
    const { rows, synced, hasChords } = this.#model();

    if (!synced && !hasChords) {
      // texto puro OU vazio: sem motor de rolagem, só o bloco estático.
      if (this.plain) {
        return html`<div class="np-lyrics-empty" style="white-space:pre-wrap;max-width:720px;font-size:17px;line-height:1.8;font-weight:600;color:rgba(255,255,255,.85)">${this.plain}</div>`;
      }
      return html`<div class="np-lyrics-empty">${this.t('player.noLyrics')}</div>`;
    }

    const slots = hasChords ? 6 : 5; // 6 linhas na janela quando há acordes
    this._slots = slots;

    return html`
      <div class="np-lyrics-track" style="transform:translate3d(0,0,0)">
        ${rows.map((r) => this.#row(r))}
      </div>
    `;
  }

  #row(r) {
    if (r.kind === 'interlude') {
      return html`<div class="np-lyric np-interlude" data-t=${r.t}><i></i><i></i><i></i></div>`;
    }
    const line = html`<syn-chord-line
      .chords=${this.#toMarks(r.chords)} .start=${r.start} .end=${r.end}
      .accent=${this.accent} .active=${false} .player=${this.player} .editable=${this.editMode}
    ></syn-chord-line>`;
    if (r.kind === 'chord-only') {
      return html`<div class="np-lyric np-chord-only" data-t=${r.t}
        @click=${() => this.#seekLine(r.t)}>${line}</div>`;
    }
    if (r.kind === 'verse-chords') {
      return html`<div class="np-lyric has-chords" data-t=${r.t}
        @click=${() => this.#seekLine(r.t)}>${line}<span class="np-line-text">${r.text}</span></div>`;
    }
    return html`<div class="np-lyric" data-t=${r.t}
      @click=${() => this.#seekLine(r.t)}>${r.text}</div>`;
  }

  // ---------- engine (porta lyricFrame/measureLyrics) ----------
  updated() {
    // player por propriedade (fora do app-root): assina o tempo dele uma vez por troca.
    if (this.player && this.player !== this._boundPlayer) {
      this._boundPlayer = this.player;
      this._time.setPlayer(this.player);
    }
    // zipa o modelo renderizado com os nós DOM (ordem = ordem do template) → âncoras.
    this._box = this.parentElement; // #npLyrics (.np-lyrics-view, position:absolute)
    this._track = this.querySelector('.np-lyrics-track');
    if (!this._track) { this._anchors = []; this._raf.stop(); return; }

    const lines = [...this._track.querySelectorAll(':scope > .np-lyric')];
    const { rows } = this.#model();
    this._anchors = lines.map((el, i) => {
      const r = rows[i] || {};
      const a = { el, t: r.t || 0, start: r.start, end: r.end, kind: r.kind };
      if (r.kind === 'interlude') { a.dots = el.querySelectorAll('i'); a.g0 = r.g0; a.g1 = r.g1; }
      else a.chordLine = el.querySelector('syn-chord-line');
      el._op = undefined; el._cy = undefined; // reset de cache (DOM novo)
      return a;
    });

    this._curTop = null; this._lastTop = -1; this._lastCenter = null;
    this.#syncRaf();
  }

  // liga o rAF quando o karaokê está ativo e há trilho; senão para (perf).
  #syncRaf() {
    if (this.active && this._anchors.length && this._track) {
      this.#measure();
      this._lastTs = 0; // não acumula dt do tempo parado
      this._raf.start();
    } else {
      this._raf.stop();
    }
  }

  #measure() {
    if (!this._track || !this._box) return;
    for (const a of this._anchors) a.el._cy = a.el.offsetTop + a.el.offsetHeight / 2;
    this._trackTop = this._track.offsetTop;
    this._maxTop = Math.max(0, this._trackTop * 2 + this._track.offsetHeight - this._box.clientHeight);
    this._curTop = null; this._lastTop = -1;
  }

  // índice da âncora em foco: a última cujo timestamp já chegou
  #activeIndex(t) {
    const A = this._anchors;
    let i = -1;
    for (let k = 0; k < A.length; k++) { if (A[k].t <= t + 0.02) i = k; else break; }
    return A.length ? Math.max(0, i) : -1;
  }

  #frame() {
    if (!this._anchors.length || !this._track || !this._box) return;
    const ch = this._box.clientHeight;
    if (!ch) return;
    const slot = ch / (this._slots || 5);
    const t = this._time.currentTime;
    const cy = (el) => (el._cy != null ? el._cy : el.offsetTop + el.offsetHeight / 2);

    const ai = this.#activeIndex(t);
    const focusEl = ai >= 0 ? this._anchors[ai].el : this._anchors[0].el;
    const target = Math.min(this._maxTop, Math.max(0, this._trackTop + cy(focusEl) - ch / 2));

    const now = performance.now();
    const dt = (this._lastTs ? Math.min(100, now - this._lastTs) : 16) / 1000;
    this._lastTs = now;
    if (this._curTop == null) { this._curTop = target; this._vel = 0; }
    // SEMPRE com mola (paridade com o karaokê legado, que nunca honrou
    // prefers-reduced-motion). A varredura suave É o recurso — encaixar direto
    // deixa a troca de linha "repentina". (Mesma decisão do syn-visualizer.)
    {
      // saltos enormes (seek distante): começa a 1,2 janelas do alvo p/ não virar borrão
      if (Math.abs(target - this._curTop) > ch * 1.2) {
        this._curTop = target + Math.sign(this._curTop - target) * ch * 1.2;
        this._vel = 0;
      }
      // mola criticamente amortecida (solução analítica — exata p/ qualquer dt)
      const w = SPRING_W;
      const dx = this._curTop - target;
      const B = this._vel + w * dx;
      const e = Math.exp(-w * dt);
      this._curTop = target + (dx + B * dt) * e;
      this._vel = (this._vel - w * B * dt) * e;
      if (Math.abs(target - this._curTop) < 0.3 && Math.abs(this._vel) < 2) {
        this._curTop = target; this._vel = 0;
      }
    }

    if (this._curTop !== this._lastTop) {
      this._track.style.transform = `translate3d(0, ${-this._curTop}px, 0)`;
      const mid = this._curTop + ch / 2 - this._trackTop;
      for (const a of this._anchors) {
        const el = a.el;
        const dPx = cy(el) - mid;            // <0 já passou (acima), >0 ainda vem (abaixo)
        const sd = Math.abs(dPx) / slot;
        let op = 1 - sd * 0.46;
        if (dPx < -slot * 0.15) op *= 0.82;  // o que já passou fica mais apagado
        op = Math.round(Math.max(0, Math.min(1, op)) * 100) / 100;
        if (el._op !== op) { el._op = op; el.style.opacity = String(op); }
      }
      this._lastTop = this._curTop;
    }

    // pontos do interlúdio: preenchem conforme avança o intervalo
    for (const a of this._anchors) {
      if (!a.dots) continue;
      const on = ai >= 0 && this._anchors[ai] === a;
      const prog = on ? Math.min(1, Math.max(0, (t - a.g0) / Math.max(0.001, a.g1 - a.g0))) : 0;
      a.dots.forEach((d, k) => d.classList.toggle('on', on && prog >= (k + 1) / (a.dots.length + 1)));
    }

    // acordes: só a linha em foco mostra a varredura → delega à folha via `.active`.
    for (let k = 0; k < this._anchors.length; k++) {
      const a = this._anchors[k];
      if (!a.chordLine) continue;
      const isActive = (k === ai);
      if (a.chordLine.active !== isActive) a.chordLine.active = isActive;
    }

    if (focusEl !== this._lastCenter) {
      if (this._lastCenter) this._lastCenter.classList.remove('active');
      focusEl.classList.add('active');
      this._lastCenter = focusEl;
    }
  }

  // ===================== Editor inline de acordes (advancedEdit) =====================
  // Mestre dos gestos sobre os syn-chord-mark embutidos; muta os objetos COMPARTILHADOS
  // de `chordsData` (= o mesmo array `npChordsLines` do renderer) → o save legado os lê.
  // Eventos `syn:chords:change` avisam o renderer (marca "sujo" / morph do botão salvar).

  #markFromEvent(e) {
    const path = e.composedPath();
    const mark = path.find((el) => el.tagName === 'SYN-CHORD-MARK');
    const line = path.find((el) => el.tagName === 'SYN-CHORD-LINE');
    return { mark, line };
  }
  #lineOf(mark) { const r = mark && mark.getRootNode(); return r && r.host && r.host.tagName === 'SYN-CHORD-LINE' ? r.host : null; }
  #markBySrc(src) {
    for (const a of this._anchors) {
      if (!a.chordLine || !a.chordLine.markEls) continue;
      for (const m of a.chordLine.markEls) if (m.src === src) return m;
    }
    return null;
  }
  #isPlaying() { const p = this.player || this._player.value; const a = p && p.audio; return a ? !a.paused : false; }
  #pause() { const p = this.player || this._player.value; if (p && p.audio) p.audio.pause(); }
  #play() { const p = this.player || this._player.value; if (p && p.audio) p.audio.play().catch(() => {}); }
  #dirty() { this.emit('syn:chords:change', {}); } // renderer → markChordsDirty()

  #select(mark, line) {
    if (this._sel === mark) { if (line) this._selLine = line; return; }
    if (this._sel) this._sel.selected = false;
    this._sel = mark || null;
    this._selLine = mark ? (line || this.#lineOf(mark)) : null;
    if (this._sel) this._sel.selected = true;
  }

  #dragStart(e) {
    if (!this.editMode) return;
    const { mark, line } = this.#markFromEvent(e);
    if (mark && line) {
      this._drag = { mark, line, src: mark.src, wasPlaying: this.#isPlaying(), moved: false, startX: e.clientX };
      this.#select(mark, line);
    } else {
      this.#select(null); // clique fora de um acorde → desseleciona
    }
  }
  #dragMove(e) {
    const d = this._drag;
    if (!d) return;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.startX) < 4) return; // limiar: distingue clique de arraste
      d.moved = true;
      if (d.wasPlaying) this.#pause(); // auto-pausa ao começar a arrastar
    }
    let tt = d.line.timeFromClientX(e.clientX);
    tt = Math.min(d.line.end - 0.001, Math.max(d.line.start, tt));
    d.src.t = Math.round(tt * 1000) / 1000;
    d.mark.time = d.src.t;
    d.line.placeMark(d.mark, d.src.t);
    this.#showHint(d.mark, d.src.t);
    this.#dirty();
    e.preventDefault();
  }
  #dragEnd() {
    const d = this._drag;
    if (!d) return;
    this._drag = null;
    this.#hideHint();
    if (d.moved) this._suppressClick = true; // não deixa o seek-da-linha disparar no fim do arraste
    if (d.moved && d.wasPlaying) this.#play();
  }

  #dblclick(e) {
    if (!this.editMode) return;
    const { mark, line } = this.#markFromEvent(e);
    if (mark) { this.#editText(mark, false); return; }
    if (line) this.#createChord(line, e.clientX);
  }

  async #createChord(line, clientX) {
    let tt = line.timeFromClientX(clientX);
    tt = Math.min(line.end - 0.001, Math.max(line.start, tt));
    const obj = { t: Math.round(tt * 1000) / 1000, text: 'C' };
    (this.chordsData || (this.chordsData = [])).push(obj);
    this.#dirty();
    this.requestUpdate();
    await this.updateComplete; await line.updateComplete;
    const mark = this.#markBySrc(obj);
    if (mark) this.#editText(mark, true); // abre o nome; cancelar/vazio remove o novo
  }

  #editText(mark, isNew) {
    this.#select(mark, this.#lineOf(mark));
    const src = mark.src;
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'np-chord-input'; inp.value = src.text || '';
    const r = mark.getBoundingClientRect();
    inp.style.cssText = `position:fixed;left:${r.left + r.width / 2}px;top:${r.top}px;transform:translateX(-50%);z-index:210`;
    document.body.appendChild(inp);
    inp.focus(); inp.select();
    let done = false;
    const commit = (keep) => {
      if (done) return; done = true; inp.remove();
      const v = inp.value.trim();
      if (keep && v) { if (v !== src.text) { src.text = v; this.#dirty(); } this.requestUpdate(); }
      else if (isNew) { const i = this.chordsData.indexOf(src); if (i >= 0) this.chordsData.splice(i, 1); this._sel = null; this.requestUpdate(); }
      else { this.requestUpdate(); }
    };
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
    });
    inp.addEventListener('blur', () => commit(true));
  }

  #editKey(e) {
    if (!this.editMode || !this._sel) return;
    const ae = document.activeElement;
    if (ae && ae.classList && ae.classList.contains('np-chord-input')) return; // editando nome
    const src = this._sel.src, line = this._selLine;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.#select(null); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault(); e.stopImmediatePropagation();
      const i = this.chordsData.indexOf(src); if (i >= 0) this.chordsData.splice(i, 1);
      this._sel = null; this.#dirty(); this.requestUpdate();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // stopImmediate: sem isso o ←/→ global trocaria de faixa ao ajustar o acorde.
      e.preventDefault(); e.stopImmediatePropagation();
      const step = e.shiftKey ? 0.1 : (e.altKey ? 0.001 : 0.01); // Shift=100ms · Alt=1ms · padrão=10ms
      let tt = src.t + (e.key === 'ArrowRight' ? step : -step);
      if (line) tt = Math.min(line.end - 0.001, Math.max(line.start, tt));
      src.t = Math.round(tt * 1000) / 1000;
      this._sel.time = src.t;
      if (line) line.placeMark(this._sel, src.t);
      this.#showHint(this._sel, src.t);
      clearTimeout(this._hintTimer); this._hintTimer = setTimeout(() => this.#hideHint(), 900);
      this.#dirty();
    }
  }

  #stamp(s) {
    s = Math.max(0, s);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(Math.floor(s % 60)).padStart(2, '0');
    const ms = String(Math.round((s - Math.floor(s)) * 1000)).padStart(3, '0');
    return `${mm}:${ss}.${ms}`;
  }
  #showHint(mark, tSec) {
    let h = this._hint;
    if (!h) { h = document.createElement('div'); h.className = 'np-chord-hint'; document.body.appendChild(h); this._hint = h; }
    h.textContent = this.#stamp(tSec); h.classList.remove('hidden');
    const r = mark.getBoundingClientRect();
    h.style.left = (r.left + r.width / 2) + 'px';
    h.style.top = (r.top - 6) + 'px';
  }
  #hideHint() { if (this._hint) this._hint.classList.add('hidden'); }
}

customElements.define('syn-lyrics', SynLyrics);

// <syn-queue> — painel da fila de reprodução. Controller montado uma vez (<syn-queue> vazio);
// OWNS por id #queuePanel/#queueList/#queueClose. Render dirigido pela fila (injetada: getQueue/
// getIndex — a fila é do engine no renderer). Reordenação por arraste. Ações saem por INTENTS:
// syn:queue:jump/remove/reorder, que o renderer (engine) executa (playAt/removeFromQueue/
// reorderQueue). Injetados: t, coverUrl, coverState, getQueue, getIndex.
import '../queue/syn-queue-item.js';

export class SynQueue extends HTMLElement {
  constructor() {
    super();
    this.t = (k) => k;
    this.coverUrl = () => '';
    this.coverState = new Map();
    this.getQueue = () => [];
    this.getIndex = () => -1;
    this._dragFrom = -1;
    this._wired = false;
  }

  #g(id) { return document.getElementById(id); }
  #emit(name, detail) { document.dispatchEvent(new CustomEvent(name, { detail })); }

  connectedCallback() {
    if (this._wired) return;
    this._wired = true;
    this.#g('queueBtn').addEventListener('click', () => this.toggle());
    this.#g('queueClose').addEventListener('click', () => this.close());
  }

  /** Abre/fecha o painel (também acionado pelo mini-player via método público). */
  toggle() {
    this.#g('eqPanel').classList.add('hidden'); // fila e EQ não coexistem
    const p = this.#g('queuePanel');
    p.classList.remove('np-mode'); // aberto pelo mini-player usa o visual padrão
    p.classList.toggle('hidden');
    if (!p.classList.contains('hidden')) this.render();
  }
  close() { const p = this.#g('queuePanel'); p.classList.add('hidden'); p.classList.remove('np-mode'); }

  render() {
    const panel = this.#g('queuePanel');
    if (panel.classList.contains('hidden')) return;
    const list = this.#g('queueList');
    const queue = this.getQueue();
    const idx = this.getIndex();
    list.innerHTML = '';
    queue.forEach((s, i) => {
      const item = document.createElement('syn-queue-item');
      item.t = this.t;
      item.vm = {
        path: s.filePath,
        title: s.title || (s.fileName || '').replace(/\.mp3$/i, ''),
        artist: s.artist || '',
        src: this.coverUrl(s),
        coverKnown: this.coverState.get(s.filePath),
        current: i === idx,
      };
      // os eventos do item bubblam (bubbles:true) → para no painel e re-emite COM o index
      item.addEventListener('syn:queue:jump', (e) => { e.stopPropagation(); this.#emit('syn:queue:jump', { index: i }); });
      item.addEventListener('syn:queue:remove', (e) => { e.stopPropagation(); this.#emit('syn:queue:remove', { index: i }); });
      item.addEventListener('syn:queue:cover', (e) => { e.stopPropagation(); this.coverState.set(s.filePath, false); });

      item.draggable = true;
      item.addEventListener('dragstart', () => { this._dragFrom = i; item.classList.add('dragging'); });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        list.querySelectorAll('.queue-item.drop-target').forEach((el) => el.classList.remove('drop-target'));
        this._dragFrom = -1;
      });
      item.addEventListener('dragover', (e) => { e.preventDefault(); item.classList.add('drop-target'); });
      item.addEventListener('dragleave', () => item.classList.remove('drop-target'));
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.classList.remove('drop-target');
        if (this._dragFrom >= 0 && this._dragFrom !== i) this.#emit('syn:queue:reorder', { from: this._dragFrom, to: i });
      });

      list.appendChild(item);
    });
  }
}
customElements.define('syn-queue', SynQueue);

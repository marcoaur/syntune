// RafController (contrato §1.6 / §2.2 / regra de ouro §4) — loop requestAnimationFrame
// gerenciado pelo ciclo de vida do host. Zonas quentes (visualizer, karaokê) escrevem
// style/canvas DIRETO no callback, SEM disparar re-render do Lit por frame.
//
// Uso:
//   this.raf = new RafController(this, (t) => { /* desenha usando t (ms) */ });
//   this.raf.start();  // ou pausa quando oculto/idle: this.raf.stop()

export class RafController {
  /**
   * @param {import('lit').ReactiveControllerHost} host
   * @param {(timeMs: number) => void} tick  chamado a cada frame
   */
  constructor(host, tick) {
    this.host = host;
    this.tick = tick;
    this._id = 0;
    this._running = false;
    host.addController(this);
  }

  start() {
    if (this._running) return;
    this._running = true;
    const loop = (t) => {
      if (!this._running) return;
      this.tick(t);
      this._id = requestAnimationFrame(loop);
    };
    this._id = requestAnimationFrame(loop);
  }

  stop() {
    this._running = false;
    if (this._id) cancelAnimationFrame(this._id);
    this._id = 0;
  }

  get running() { return this._running; }

  // Liga só enquanto o host está conectado; libera o rAF ao desconectar.
  hostConnected() { /* início sob demanda via start() */ }
  hostDisconnected() { this.stop(); }
}

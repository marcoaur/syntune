// MediaTimeController (contrato §2.2 / §3.1) — assina o tempo de reprodução do
// PlayerService e expõe currentTime ao host SEM re-render por frame. O host lê
// `controller.currentTime` dentro do seu próprio loop (RafController) p/ posicionar
// barra/letra de forma imperativa. Karaokê/sweep usam isto.
//
// Uso:
//   this.time = new MediaTimeController(this, playerService);
//   // dentro de um RafController: const t = this.time.currentTime;

export class MediaTimeController {
  /**
   * @param {import('lit').ReactiveControllerHost} host
   * @param {{ audio?: HTMLAudioElement, currentTime?: number }} player  PlayerService (ou alvo c/ <audio>)
   */
  constructor(host, player) {
    this.host = host;
    this.player = player;
    this._t = 0;
    this._onTime = () => { this._t = this._readTime(); };
    host.addController(this);
  }

  _readTime() {
    if (this.player && typeof this.player.currentTime === 'number') return this.player.currentTime;
    if (this.player && this.player.audio) return this.player.audio.currentTime || 0;
    return 0;
  }

  /**
   * Tempo atual (s) — leitura AO VIVO (não depende de quando o controller foi criado
   * nem do disparo coarse de 'timeupdate'). O loop de rAF do host lê isto por frame.
   */
  get currentTime() { return this._readTime(); }

  /** Troca a fonte (ex.: PlayerService chega async via context). */
  setPlayer(player) {
    const prev = this.player && this.player.audio;
    if (prev) prev.removeEventListener('timeupdate', this._onTime);
    this.player = player;
    const el = player && player.audio;
    if (el) el.addEventListener('timeupdate', this._onTime);
  }

  hostConnected() {
    const el = this.player && this.player.audio;
    if (el) el.addEventListener('timeupdate', this._onTime);
    this._t = this._readTime();
  }

  hostDisconnected() {
    const el = this.player && this.player.audio;
    if (el) el.removeEventListener('timeupdate', this._onTime);
  }
}

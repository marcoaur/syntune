// @ts-check
// ApiService (contrato §2.1) — wrapper fino e ÚNICA ponte do renderer ao main via
// window.api (exposto pelo preload). Nenhum componente importa window.api direto:
// consome este serviço pelo apiContext. Tipado contra IpcApi (src/ipc/contract.js):
// o editor/tsc cobra que os canais batem com o contrato.
//
// Por ora é um pass-through tipado: cada método espelha window.api. Ganchos de
// validação/telemetria entram aqui depois (sem mexer nos componentes).

/** @typedef {import('../../src/ipc/contract.js').IpcApi} IpcApi */

export class ApiService {
  /** @param {IpcApi} [api] injeção p/ teste; default = window.api real */
  constructor(api) {
    // window.api não está no tipo DOM Window → cast pontual; o contrato real é IpcApi.
    const bridge = api || (typeof window !== 'undefined' ? /** @type {any} */ (window).api : undefined);
    if (!bridge) throw new Error('ApiService: window.api indisponível (preload não carregou?)');
    /** @type {IpcApi} */
    this.api = bridge;
  }

  // --- atalhos mais usados pelas ilhas (crescem conforme a migração) ---
  /** @returns {Promise<{ strings: Record<string,string>, lang: string }>} */
  getI18n() { return this.api.getI18n(); }
  /** @returns {Promise<object>} */
  getConfig() { return this.api.getConfig(); }
  setConfig(cfg) { return this.api.setConfig(cfg); }
  libraryList() { return this.api.libraryList(); }
  chordsGet(filePath) { return this.api.chordsGet(filePath); }
  chordsSet(filePath, chords) { return this.api.chordsSet(filePath, chords); }

  /** Escotilha de fuga: acesso direto à ponte p/ canais ainda não espelhados acima. */
  get raw() { return this.api; }
}

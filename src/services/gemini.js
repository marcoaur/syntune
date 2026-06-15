/**
 * @module  services/gemini
 * @badge   🟦 SERVICE · NETWORK · RATE-LIMITED(RPM/TPM/RPD) · STATEFUL(per-model FIFO queue) · FACTORY-DI
 * @role    Per-model Gemini rate-limit engine (FIFO queue, daily RPD persisted) + structured single-call JSON helper.
 * @inputs  createGeminiService({ readConfig, writeConfig }); callGemini(cfg, prompt, schema, onWait)
 * @outputs parsed JSON object (throws on API/parse error); ID3_SCHEMA constant
 * @deps    global fetch, ../../i18n; injected readConfig/writeConfig (RPD persistence)
 * @notes   Stateful: holds in-memory per-model usage windows; one instance per app.
 */
const i18n = require('../../i18n');
const t = i18n.t;

module.exports = function createGeminiService({ readConfig, writeConfig }) {
  // ---------- Gemini: motor de limite de requisições (por modelo, FIFO) ----------
  // Cada modelo tem seus próprios limites: RPM (requisições/min), TPM (tokens/min)
  // e RPD (requisições/dia). Toda chamada passa por aqui; quando algum limite do
  // modelo está saturado, as próximas chamadas DAQUELE modelo aguardam em fila,
  // preservando a ordem de chegada (que reflete a ordem de término dos downloads).
  // Modelos diferentes não bloqueiam uns aos outros.
  const MODEL_LIMITS = {
    'gemini-3.1-flash-lite': { rpm: 15, tpm: 250000, rpd: 500 },
    'gemini-2.5-flash': { rpm: 5 }
  };
  const DEFAULT_LIMITS = { rpm: 5 };
  const RPM_WINDOW = 60_000;
  const TPM_WINDOW = 60_000;
  const RPD_WINDOW = 24 * 60 * 60_000;

  function getLimits(model) { return MODEL_LIMITS[model] || DEFAULT_LIMITS; }

  // estado de uso por modelo
  const geminiState = new Map(); // model -> { reqTimes:[], tokenEvents:[{t,tokens}], dayTimes:[] }
  function stateFor(model) {
    let s = geminiState.get(model);
    if (!s) { s = { reqTimes: [], tokenEvents: [], dayTimes: [] }; geminiState.set(model, s); }
    return s;
  }

  let geminiWaitQueue = [];   // { model, tokens, resolve, onWait }
  let geminiPumpTimer = null;

  function pruneState(s, now) {
    s.reqTimes = s.reqTimes.filter((t) => now - t < RPM_WINDOW);
    s.tokenEvents = s.tokenEvents.filter((e) => now - e.t < TPM_WINDOW);
    s.dayTimes = s.dayTimes.filter((t) => now - t < RPD_WINDOW);
  }

  // avalia se uma chamada pode rodar já; senão, retorna a menor espera (ms) e o motivo
  function canRunGemini(model, tokens, now) {
    const lim = getLimits(model);
    const s = stateFor(model);
    pruneState(s, now);
    let waitMs = 0, reason = '';
    const consider = (w, why) => { if (w > waitMs) { waitMs = w; reason = why; } };

    if (lim.rpm != null && s.reqTimes.length >= lim.rpm) {
      consider(RPM_WINDOW - (now - s.reqTimes[0]), t('main.reason.rpm'));
    }
    if (lim.rpd != null && s.dayTimes.length >= lim.rpd) {
      consider(RPD_WINDOW - (now - s.dayTimes[0]), t('main.reason.rpd'));
    }
    if (lim.tpm != null) {
      const used = s.tokenEvents.reduce((a, e) => a + e.tokens, 0);
      if (used + tokens > lim.tpm && s.tokenEvents.length) {
        consider(TPM_WINDOW - (now - s.tokenEvents[0].t), t('main.reason.tpm'));
      }
    }
    return waitMs <= 0 ? { ok: true } : { ok: false, waitMs, reason };
  }

  function pumpGeminiQueue() {
    const now = Date.now();
    const blocked = new Set(); // modelos já bloqueados nesta passada (preserva ordem por modelo)
    let minWait = Infinity;
    let granted = false;

    let i = 0;
    while (i < geminiWaitQueue.length) {
      const item = geminiWaitQueue[i];
      if (blocked.has(item.model)) { i++; continue; }
      const res = canRunGemini(item.model, item.tokens, now);
      if (res.ok) {
        const s = stateFor(item.model);
        s.reqTimes.push(now);
        s.dayTimes.push(now);
        s.tokenEvents.push({ t: now, tokens: item.tokens });
        geminiWaitQueue.splice(i, 1);
        item.resolve();
        granted = true;
      } else {
        blocked.add(item.model);
        if (res.waitMs < minWait) minWait = res.waitMs;
        if (item.onWait) item.onWait(Math.max(1, Math.ceil(res.waitMs / 1000)), res.reason);
        i++;
      }
    }

    if (granted) persistGeminiUsage(); // grava o uso diário (RPD) para sobreviver a reinícios

    if (geminiWaitQueue.length) {
      clearTimeout(geminiPumpTimer);
      const delay = Math.max(50, Math.min(minWait + 50, 30000));
      geminiPumpTimer = setTimeout(pumpGeminiQueue, delay);
    }
  }

  function acquireGeminiSlot(model, tokens, onWait) {
    return new Promise((resolve) => {
      geminiWaitQueue.push({ model, tokens, resolve, onWait });
      pumpGeminiQueue();
    });
  }

  // Persistência do uso diário (RPD) no config.json, para sobreviver a reinícios.
  // Só os timestamps dentro da janela de 24h importam; o resto é descartado.
  function loadGeminiUsage() {
    const cfg = readConfig();
    const usage = cfg.geminiUsage || {};
    const now = Date.now();
    for (const model of Object.keys(usage)) {
      const arr = (Array.isArray(usage[model]) ? usage[model] : [])
        .filter((t) => typeof t === 'number' && now - t < RPD_WINDOW);
      stateFor(model).dayTimes = arr;
    }
  }

  function persistGeminiUsage() {
    const now = Date.now();
    const usage = {};
    for (const [model, s] of geminiState) {
      const recent = s.dayTimes.filter((t) => now - t < RPD_WINDOW);
      if (recent.length) usage[model] = recent;
    }
    try {
      const cfg = readConfig();
      cfg.geminiUsage = usage;
      writeConfig(cfg);
    } catch { /* best-effort */ }
  }

  // estimativa grosseira de tokens (entrada ~ chars/4 + orçamento de saída)
  function estimateTokens(prompt) {
    return Math.ceil((prompt ? prompt.length : 0) / 4) + 1200;
  }

  // ---------- Gemini: helper de chamada única (JSON estruturado) ----------
  // onWait(segundos, motivo) é chamado caso a requisição precise aguardar o limite.
  async function callGemini(cfg, prompt, schema, onWait) {
    const model = cfg.model || 'gemini-2.5-flash';
    await acquireGeminiSlot(model, estimateTokens(prompt), onWait);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;

    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: schema
      }
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const errText = await resp.text();
      let msg = t('main.apiError', { status: resp.status });
      try {
        const j = JSON.parse(errText);
        if (j.error && j.error.message) msg = `Gemini: ${j.error.message}`;
      } catch { /* mantém msg padrão */ }
      throw new Error(msg);
    }

    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error(t('main.apiNoContent'));
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(t('main.apiParseFail'));
    }
  }

  // Schema do JSON final de metadados ID3 (usado pela 2ª chamada e pelo formulário).
  const ID3_SCHEMA = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      artist: { type: 'string' },
      album: { type: 'string' },
      albumArtist: { type: 'string' },
      year: { type: 'string' },
      genre: { type: 'string' },
      trackNumber: { type: 'string' },
      partOfSet: { type: 'string' },
      composer: { type: 'string' },
      publisher: { type: 'string' },
      comment: { type: 'string' },
      lyrics: { type: 'string' }
    },
    required: ['title', 'artist', 'album']
  };

  return { callGemini, loadGeminiUsage, estimateTokens, acquireGeminiSlot, ID3_SCHEMA };
};

// PaletteCapability (ARCHITECTURE-V2) — CAPACIDADE headless de compute puro: extrai a
// cor-chave (dominante + vibrante) de uma capa, com cache. Não tem cara nem DOM — é
// trabalho-duro chamável. Acesso via capabilities.js: `palette().of(url)` → {r,g,b,text}|null.
// Singleton (cache em instância). Sem dependência do renderer (loadImage próprio).
export class PaletteCapability {
  constructor() { this._cache = new Map(); }

  #loadImage(src, crossOrigin) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (crossOrigin) img.crossOrigin = 'anonymous'; // p/ getImageData sem taint
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  /** Cor-chave da capa (cache por URL). @returns {Promise<{r,g,b,text}|null>} */
  async of(dataUrl) {
    if (!dataUrl) return null;
    if (this._cache.has(dataUrl)) return this._cache.get(dataUrl);

    let pal = null;
    try {
      // URLs de protocolo custom precisam de CORS p/ getImageData; data URLs não.
      // Falha de CORS → tenta sem (pode dar taint → catch → null, nada quebra).
      const needsCors = !dataUrl.startsWith('data:');
      let img;
      try { img = await this.#loadImage(dataUrl, needsCors); }
      catch { img = await this.#loadImage(dataUrl); }
      const S = 32;
      const c = document.createElement('canvas');
      c.width = S; c.height = S;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, S, S);
      const { data } = ctx.getImageData(0, 0, S, S);

      // quantiza em baldes e pondera por saturação para achar a cor "chave"
      const buckets = new Map();
      let avgR = 0, avgG = 0, avgB = 0, avgN = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a < 125) continue;
        avgR += r; avgG += g; avgB += b; avgN++;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum < 28 || lum > 232) continue; // ignora quase preto/branco
        const key = `${r >> 5},${g >> 5},${b >> 5}`;
        const prev = buckets.get(key) || { r: 0, g: 0, b: 0, w: 0 };
        const w = 1 + sat * 3; // valoriza cores saturadas
        prev.r += r * w; prev.g += g * w; prev.b += b * w; prev.w += w;
        buckets.set(key, prev);
      }

      let best = null;
      for (const v of buckets.values()) if (!best || v.w > best.w) best = v;
      let r, g, b;
      if (best) {
        r = Math.round(best.r / best.w);
        g = Math.round(best.g / best.w);
        b = Math.round(best.b / best.w);
      } else if (avgN) {
        r = Math.round(avgR / avgN); g = Math.round(avgG / avgN); b = Math.round(avgB / avgN);
      }
      if (r != null) {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        pal = { r, g, b, text: lum > 150 ? '#1d1d1f' : '#ffffff' };
      }
    } catch { /* sem paleta */ }

    this._cache.set(dataUrl, pal);
    return pal;
  }
}

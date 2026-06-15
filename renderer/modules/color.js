/**
 * @module  renderer/color
 * @badge   ⬜ UTIL · RENDERER · PURE · ESM
 * @role    Conversões de cor RGB↔HSL (base da paleta dinâmica derivada da capa).
 * @inputs  componentes RGB (0-255) / HSL (h:0-360, s/l:0-1)
 * @outputs { h, s, l } / [r, g, b]
 * @deps    (nenhum)
 */
export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h: h * 360, s, l };
}

export function hslToRgb(h, s, l) {
  h /= 360; let r, g, b;
  if (s === 0) { r = g = b = l; } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// cores das barras: fiéis à paleta da capa (MESMO matiz), com saturação preservada
// e o contraste vindo só da luminosidade — deslocada na direção do texto do card
// (clareia sobre capa escura, escurece sobre capa clara) para "destoar" do fundo.
export function deriveBarColors(pal) {
  if (!pal) return { bottom: 'rgba(0,122,255,0.85)', top: 'rgba(110,170,255,0.97)' };
  const { h, s, l } = rgbToHsl(pal.r, pal.g, pal.b);
  const dark = pal.text === '#ffffff'; // capa escura → barras mais claras; clara → mais escuras
  // preserva a vivacidade da capa, com um leve reforço e um piso p/ capas acinzentadas
  const sat = Math.min(1, Math.max(0.4, s * 1.12 + 0.06));
  // a base da barra fica perto da luminosidade da própria capa; o topo brilha
  const lBottom = dark
    ? Math.min(0.62, Math.max(0.40, l + 0.10))
    : Math.max(0.34, Math.min(0.50, l - 0.10));
  const lTop = dark
    ? Math.min(0.86, lBottom + 0.22)
    : Math.min(0.66, lBottom + 0.20);
  const [r1, g1, b1] = hslToRgb(h, sat, lBottom);
  const [r2, g2, b2] = hslToRgb(h, Math.min(1, sat + 0.06), lTop);
  return { bottom: `rgba(${r1},${g1},${b1},0.88)`, top: `rgba(${r2},${g2},${b2},0.98)` };
}

// interpola a paleta corrente até a alvo (transição suave de cor entre faixas);
// recalcula a cor de texto ideal (claro/escuro) pela luminância resultante.
export function lerpPal(cur, target, k) {
  if (!cur) return { r: target.r, g: target.g, b: target.b, text: target.text };
  const r = cur.r + (target.r - cur.r) * k;
  const g = cur.g + (target.g - cur.g) * k;
  const b = cur.b + (target.b - cur.b) * k;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  return { r, g, b, text: lum > 150 ? '#1d1d1f' : '#ffffff' };
}

/**
 * @module  electron.vite.config
 * @role    Config do electron-vite (main + preload + renderer num só lugar). Ver
 *          FRONTEND-MIGRATION.md §2.4. Aditivo: NÃO substitui `electron .` / `electron-builder`
 *          atuais — apenas habilita `electron-vite dev` (HMR) e `electron-vite build` (out/).
 * @notes   - main/preload ficam em CommonJS (require). externalizeDepsPlugin mantém os
 *            módulos de node_modules (electron-updater, node-id3, yt-dlp-wrap) fora do bundle.
 *          - Saídas: out/main/index.js, out/preload/preload.js, out/renderer/. main.js detecta
 *            o layout em runtime (ver main.js) p/ resolver preload/renderer nos dois modos.
 *          - O cutover de produção (package.json `main`→out/ + build.files→out/) é decisão
 *            posterior (§5); por ora `npm run dist` segue empacotando a raiz.
 */
const { resolve } = require('path');
const { defineConfig, externalizeDepsPlugin } = require('electron-vite');

// Plugin dev-only: troca a CSP estrita do index.html por uma permissiva ao HMR do Vite
// (cliente conecta via WebSocket; módulos vêm do dev-server). Só roda no `serve` (dev) —
// o `build` de produção preserva a CSP original do HTML intacta. Mantém os esquemas custom
// (mp3file:/mp3cover:/mp3artist:) liberados também em dev.
const relaxCspForHmr = () => ({
  name: 'syntune:relax-csp-dev',
  apply: 'serve',
  transformIndexHtml(html) {
    return html.replace(
      /<meta http-equiv="Content-Security-Policy"[\s\S]*?>/i,
      '<meta http-equiv="Content-Security-Policy" content="'
        + "default-src 'self'; "
        + "img-src 'self' data: blob: mp3cover: mp3artist:; "
        + "media-src 'self' mp3file:; "
        + "style-src 'self' 'unsafe-inline'; "
        + "script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
        + "connect-src 'self' ws: wss: http: https:;"
        + '" />'
    );
  },
});

module.exports = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'main.js'), formats: ['cjs'] },
      rollupOptions: { output: { entryFileNames: 'index.js' } },
      // Vite só roda o plugin commonjs em node_modules por padrão; nosso main é CJS e
      // requer src/**, i18n, sync-engine via require() relativo. Incluímos os .js/.cjs do
      // projeto p/ esses relativos serem BUNDLADOS (senão virariam require runtime em
      // out/main, onde não existem). node_modules seguem externos (externalizeDepsPlugin).
      // sync-worker.js NÃO entra: é carregado por worker_threads como arquivo à parte.
      commonjsOptions: { include: [/node_modules/, /\.c?js$/], transformMixedEsModules: true },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      lib: { entry: resolve(__dirname, 'preload.js'), formats: ['cjs'] },
      rollupOptions: { output: { entryFileNames: 'preload.js' } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'renderer'),
    plugins: [relaxCspForHmr()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          // entry real (HTML do app) + barrel Lit (valida o grafo de componentes no build)
          index: resolve(__dirname, 'renderer/index.html'),
          components: resolve(__dirname, 'renderer/components/index.js'),
        },
      },
    },
  },
});

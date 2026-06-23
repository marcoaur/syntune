// Config do @web/test-runner — testes de componentes Lit no browser real (DoD §3 / §2.7).
// Usa o launcher do Playwright (playwright-core já é dep do projeto). Roda os *.test.js
// dos componentes. Ver FRONTEND-MIGRATION.md (gate automatizado no CI).
import { playwrightLauncher } from '@web/test-runner-playwright';

export default {
  files: 'renderer/components/**/*.test.js',
  nodeResolve: true,
  browsers: [playwrightLauncher({ product: 'chromium' })],
  testFramework: { config: { ui: 'bdd', timeout: '4000' } },
};

// Smoke E2E: lança o app Electron real e garante que ele ABRE e RENDERIZA sem
// erro de JS no boot. Pega a classe de regressão "tela branca / import ESM
// quebrado / IPC falhando no startup" antes do usuário.
//
// Fica FORA de test/ de propósito: o `node --test` auto-descobre tudo sob test/,
// e não queremos lançar Electron no `npm test` (unit). Rode com `npm run test:e2e`.
// Em CI/Linux precisa de display → `xvfb-run npm run test:e2e`.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('app boota: janela abre, UI principal renderiza, sem erro de JS', { timeout: 90000 }, async () => {
  const app = await electron.launch({ args: ['.'], cwd: root });
  try {
    const win = await app.firstWindow();

    // captura exceções não tratadas do renderer durante o boot
    const pageErrors = [];
    win.on('pageerror', (e) => pageErrors.push(e.message));

    await win.waitForLoadState('domcontentloaded');

    // elemento sempre presente após o boot (engrenagem de Configurações)
    await win.waitForSelector('#settingsBtn', { timeout: 20000, state: 'attached' });
    assert.equal(await win.locator('#settingsBtn').count(), 1, 'UI principal ausente — boot/render quebrado');

    // dá um tempo p/ o startup assíncrono (i18n via IPC, init de EQ/sync) estourar erro, se houver
    await win.waitForTimeout(1500);
    assert.equal(pageErrors.length, 0, 'erro(s) de JS no boot: ' + pageErrors.join(' | '));
  } finally {
    await app.close();
  }
});

test('Configurações: accordion abre só 1 seção por vez', { timeout: 60000 }, async () => {
  const app = await electron.launch({ args: ['.'], cwd: root });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForSelector('#settingsBtn', { timeout: 20000 });
    await win.click('#settingsBtn');
    await win.waitForSelector('#settingsAcc .acc-item', { timeout: 10000 });

    // estado inicial: exatamente 1 seção aberta
    assert.equal(await win.locator('#settingsAcc .acc-item.open').count(), 1, 'deveria abrir 1 seção por padrão');

    // clica a 3ª seção → continua 1 aberta, e é a clicada (as outras colapsam)
    await win.locator('#settingsAcc .acc-head').nth(2).click();
    assert.equal(await win.locator('#settingsAcc .acc-item.open').count(), 1, 'só 1 seção pode ficar aberta');
    const thirdOpen = await win.locator('#settingsAcc .acc-item').nth(2).evaluate((el) => el.classList.contains('open'));
    assert.ok(thirdOpen, 'a seção clicada deveria estar aberta');
  } finally {
    await app.close();
  }
});

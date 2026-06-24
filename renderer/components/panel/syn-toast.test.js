// Teste do syn-toast (DoD §3). Conectado (arquétipo C): consome o ToastService via context.
// Monta dentro do <syn-app-root> (provider real) e dispara toast() pelo serviço.
import { fixture, html, expect } from '@open-wc/testing';
// O <syn-app-root>/core-store instanciam o ApiService no eval (exige window.api do preload,
// ausente no browser de teste). O stub PRECISA ser aplicado antes desses imports — ESM avalia
// imports estáticos em ordem, então este vem primeiro.
import '../test-api-stub.js';
import '../app-root.js';
import './index.js';

describe('syn-toast (conectado / arquétipo C)', () => {
  it('mostra a mensagem do ToastService com ícone de sucesso', async () => {
    const root = await fixture(html`<syn-app-root><syn-toast></syn-toast></syn-app-root>`);
    const el = root.querySelector('syn-toast');
    root.services.toast.toast('Salvo!', 'success');
    await el.updateComplete;
    expect(el.shadowRoot.querySelector('.msg').textContent).to.equal('Salvo!');
    expect(el.shadowRoot.querySelector('.ic').textContent).to.equal('✓');
    expect(el.shadowRoot.querySelector('.toast').classList.contains('success')).to.be.true;
  });

  it('erro usa aria-live assertive', async () => {
    const root = await fixture(html`<syn-app-root><syn-toast></syn-toast></syn-app-root>`);
    const el = root.querySelector('syn-toast');
    root.services.toast.toast('Falhou', 'error');
    await el.updateComplete;
    expect(el.shadowRoot.querySelector('.toast').getAttribute('aria-live')).to.equal('assertive');
  });

  it('nada renderizado antes de qualquer toast', async () => {
    const root = await fixture(html`<syn-app-root><syn-toast></syn-toast></syn-app-root>`);
    const el = root.querySelector('syn-toast');
    await el.updateComplete;
    expect(el.shadowRoot.querySelector('.toast')).to.not.exist;
  });
});

// <syn-settings> — VIEW inteligente (ARCHITECTURE-V2) das Configurações. ADOTA o markup do
// modal (light-DOM já no index.html: tag-swap de #settingsModal) e é DONO de todos os seus
// eventos + do domínio (carregar/salvar config via api, idioma, toggles, auth Last.fm,
// accordion). NÃO re-renderiza (preserva o form + os IDs + a CSS). Plain custom element.
//
// Contrato: trata os próprios eventos; acionador externo = `open()` (o botão da topbar chama).
// Efeitos cross-subsistema do salvar (reload da biblioteca, advancedEdit, caches, karaokê)
// NÃO são dele → emite `syn:settings:saved {advancedEdit, geniusChanged, lastfmChanged}` e o
// renderer reage. Injetados pelo renderer: `t`, `toast`, `closeView`. Usa a capacidade confirm.
import { confirm as confirmCap } from '../capabilities.js';

const LANG_NAMES = { en: 'English', pt: 'Português', 'pt-br': 'Português (Brasil)', 'pt-pt': 'Português (Portugal)', es: 'Español', fr: 'Français', de: 'Deutsch', it: 'Italiano', ru: 'Русский', ja: '日本語', zh: '中文' };

export class SynSettings extends HTMLElement {
  constructor() {
    super();
    this.t = (k) => k;
    this.toast = () => {};
    this.closeView = (el) => el.classList.add('hidden');
    this._langConfigured = 'auto';
    this._wired = false;
  }

  #$(sel) { return this.querySelector(sel); }
  #emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail })); }

  connectedCallback() {
    if (this._wired) return; // idempotente (markup já no DOM)
    this._wired = true;
    const $ = (s) => this.#$(s);

    $('#browseFolder').addEventListener('click', async () => {
      const dir = await window.api.selectFolder();
      if (dir) $('#downloadFolder').value = dir;
    });
    $('#clearFolder').addEventListener('click', () => { $('#downloadFolder').value = ''; });
    $('#cancelSettings').addEventListener('click', () => this.closeView(this));
    this.addEventListener('click', (e) => { if (e.target === this) this.closeView(this); });

    // accordion: single-open (o syn-setting-section emite syn:setting:toggle)
    this.addEventListener('syn:setting:toggle', (e) => {
      if (!e.detail || !e.detail.open) return;
      this.querySelectorAll('syn-setting-section').forEach((s) => { if (s !== e.target) s.open = false; });
    });

    $('#lastfmScrobbleEnabled').addEventListener('change', (e) => {
      $('#lastfmScrobbleFields').classList.toggle('hidden', !e.target.checked);
    });

    // "Usar IA no Syntune CLI?" — ação imediata (não espera o Salvar)
    $('#useCliAi').addEventListener('change', async (e) => {
      const on = e.target.checked;
      if (on && !(await confirmCap().ask({ message: this.t('settings.cliAiConfirm'), cancelLabel: this.t('common.cancel') }))) {
        e.target.checked = false; return;
      }
      try {
        const res = await window.api.cliSetAiEnabled(on);
        if (on) this.toast(res.hasKey ? this.t('settings.cliAiOnWithKey') : this.t('settings.cliAiOnNoKey'), 'success');
        else this.toast(this.t('settings.cliAiOff'), 'success');
      } catch {
        e.target.checked = !on;
        this.toast(this.t('settings.cliAiError'), 'error');
      }
    });

    $('#btnAuthLastfm').addEventListener('click', async () => {
      const apiKey = $('#lastfmApiKey').value.trim();
      const secret = $('#lastfmSecret').value.trim();
      if (!apiKey || !secret) { $('#lastfmAuthHint').textContent = this.t('settings.lastfmAuthMissing'); return; }
      $('#lastfmAuthHint').textContent = this.t('settings.lastfmAuthWaiting');
      const res = await window.api.lastfmAuthSession({ apiKey, secret });
      if (res.error) $('#lastfmAuthHint').textContent = this.t('settings.lastfmAuthError', { msg: res.error });
      else { $('#lastfmSessionKey').value = res.sessionKey; $('#lastfmAuthHint').textContent = this.t('settings.lastfmAuthLinked', { user: res.username }); }
    });

    $('#saveSettings').addEventListener('click', () => this.#save());
  }

  // troca cada .acc-item legado por <syn-setting-section>, MOVENDO o corpo (.acc-body) p/ o
  // slot — preserva os inputs (IDs). Idempotente.
  #upgradeAccordion() {
    const acc = this.#$('#settingsAcc');
    if (!acc) return;
    for (const item of [...acc.querySelectorAll(':scope > .acc-item')]) {
      const span = item.querySelector('.acc-head span');
      const body = item.querySelector('.acc-body');
      if (!body) continue;
      const sec = document.createElement('syn-setting-section');
      sec.heading = span ? span.textContent : '';
      sec.open = item.classList.contains('open');
      while (body.firstChild) sec.appendChild(body.firstChild);
      acc.replaceChild(sec, item);
    }
  }

  async #populateLanguageSelect() {
    let info = {};
    try { info = await window.api.getI18n(); } catch { /* padrões */ }
    const available = Array.isArray(info.available) ? info.available : [];
    this._langConfigured = info.configured ? String(info.configured).toLowerCase() : 'auto';
    const sel = this.#$('#language');
    sel.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = 'auto'; auto.textContent = this.t('settings.languageAuto');
    sel.appendChild(auto);
    for (const code of available) {
      const o = document.createElement('option');
      o.value = code; o.textContent = LANG_NAMES[code] || code.toUpperCase();
      sel.appendChild(o);
    }
    sel.value = available.includes(this._langConfigured) ? this._langConfigured : 'auto';
  }

  /** Acionador externo: abre o modal, carrega a config e preenche o form. */
  async open() {
    const $ = (s) => this.#$(s);
    const cfg = await window.api.getConfig();
    await this.#populateLanguageSelect();
    $('#apiKey').value = cfg.apiKey || '';
    $('#useAi').checked = cfg.useAi !== false;
    $('#advancedEdit').checked = cfg.advancedEdit === true;
    try {
      const cli = await window.api.cliDetect();
      $('#cliAiRow').classList.toggle('hidden', !cli.installed);
      $('#useCliAi').checked = cfg.useCliAi === true;
    } catch { $('#cliAiRow').classList.add('hidden'); }
    $('#geniusToken').value = cfg.geniusToken || '';
    $('#lastfmApiKey').value = cfg.lastfmApiKey || '';
    $('#lastfmSecret').value = cfg.lastfmSecret || '';
    $('#lastfmScrobbleEnabled').checked = !!cfg.lastfmScrobbleEnabled;
    $('#lastfmSessionKey').value = cfg.lastfmSessionKey || '';
    $('#lastfmScrobbleFields').classList.toggle('hidden', !cfg.lastfmScrobbleEnabled);
    $('#model').value = cfg.model || 'gemini-2.5-flash';
    $('#downloadFolder').value = cfg.downloadFolder || '';
    try { $('#appVersion').textContent = this.t('settings.version', { v: await window.api.getVersion() }); } catch {}
    this.#upgradeAccordion();
    this.classList.remove('hidden', 'closing');
  }

  async #save() {
    const $ = (s) => this.#$(s);
    const prev = await window.api.getConfig();
    const geniusToken = $('#geniusToken').value.trim();
    const lastfmApiKey = $('#lastfmApiKey').value.trim();
    await window.api.setConfig({
      apiKey: $('#apiKey').value.trim(),
      useAi: $('#useAi').checked,
      advancedEdit: $('#advancedEdit').checked,
      geniusToken,
      lastfmApiKey,
      lastfmSecret: $('#lastfmSecret').value.trim(),
      lastfmScrobbleEnabled: $('#lastfmScrobbleEnabled').checked,
      lastfmSessionKey: $('#lastfmSessionKey').value.trim(),
      model: $('#model').value,
      downloadFolder: $('#downloadFolder').value.trim(),
    });
    // troca de idioma: aplica reiniciando o app (o relaunch encerra a execução)
    const langSel = $('#language').value;
    if (langSel !== this._langConfigured) {
      await window.api.setLanguage(langSel === 'auto' ? '' : langSel);
      return;
    }
    this.closeView(this);
    this.toast(this.t('settings.saved'), 'success');
    // efeitos cross-subsistema ficam com o renderer (reload/caches/advancedEdit/karaokê)
    this.#emit('syn:settings:saved', {
      advancedEdit: $('#advancedEdit').checked,
      geniusChanged: geniusToken !== (prev.geniusToken || ''),
      lastfmChanged: lastfmApiKey !== (prev.lastfmApiKey || ''),
    });
  }
}
customElements.define('syn-settings', SynSettings);

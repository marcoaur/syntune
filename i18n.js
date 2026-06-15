/**
 * @module  i18n
 * @badge   ⬜ UTIL · I18N · STATEFUL(idioma atual) · NO-NET
 * @role    Motor de idiomas: casa o locale do SO com locales/<idioma>.json e expõe t(), getLanguage(), getStrings().
 * @inputs  locale do sistema, locales/*.json, chave + vars
 * @outputs string traduzida, idioma ativo, dicionário
 * @deps    fs, path, electron(app)
 */
// ====================================================================
// Motor de idiomas (i18n)
// --------------------------------------------------------------------
// - Os textos da interface vivem em locales/<idioma>.json (chave -> texto).
// - Na 1ª execução, o locale do sistema é casado com um arquivo de idioma:
//   * match exato (ex.: "pt-br" se existir locales/pt-br.json), senão
//   * idioma-base (ex.: "pt-BR"/"pt-PT"/"pt-AO" -> "pt"; "en-US"/"en-GB" -> "en").
// - Havendo match, o idioma é gravado em config.json ("language") e a
//   detecção não roda mais (cache permanente).
// - Sem match, o app usa o inglês SEM gravar nada: a verificação se repete
//   a cada inicialização, de modo que basta adicionar um novo arquivo em
//   locales/ (ex.: es.json) para a interface passar a usá-lo automaticamente.
// - O inglês é a base: chaves ausentes numa tradução caem no texto em inglês.
// ====================================================================
const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, 'locales');
const DEFAULT_LANG = 'en';

let currentLang = DEFAULT_LANG;
let strings = {};

// idiomas disponíveis = arquivos .json presentes em locales/
function availableLanguages() {
  try {
    return fs.readdirSync(LOCALES_DIR)
      .filter((f) => f.toLowerCase().endsWith('.json'))
      .map((f) => f.slice(0, -5).toLowerCase());
  } catch {
    return [];
  }
}

function loadLanguage(lang) {
  try {
    return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, lang + '.json'), 'utf-8')) || {};
  } catch {
    return {};
  }
}

// casa um locale (ex.: "pt-BR", "en_GB", "es-419") com um idioma disponível
function matchLocale(locale) {
  const langs = availableLanguages();
  const lower = String(locale || '').toLowerCase().replace(/_/g, '-').trim();
  if (!lower) return null;
  if (langs.includes(lower)) return lower;          // match exato (pt-br, en-gb…)
  const base = lower.split('-')[0];
  if (langs.includes(base)) return base;            // match pelo idioma-base (pt, en…)
  return null;
}

// Resolve e carrega o idioma do app. Deve ser chamado no início (app ready).
// readConfig/writeConfig são injetados pelo main para persistir em config.json.
function init({ locale, readConfig, writeConfig }) {
  const langs = availableLanguages();
  const saved = readConfig().language;

  if (saved && langs.includes(String(saved).toLowerCase())) {
    // idioma já resolvido numa execução anterior: usa o cache, sem detecção
    currentLang = String(saved).toLowerCase();
  } else {
    const match = matchLocale(locale);
    if (match) {
      // grava o match no config.json e desativa a verificação recorrente
      currentLang = match;
      try {
        const cfg = readConfig();
        cfg.language = match;
        writeConfig(cfg);
      } catch { /* best-effort: sem cache, detecta de novo no próximo início */ }
    } else {
      // sem idioma para este locale: inglês como padrão, SEM gravar — a
      // verificação roda de novo a cada início até existir um match
      currentLang = DEFAULT_LANG;
    }
  }

  const base = loadLanguage(DEFAULT_LANG);
  const chosen = currentLang === DEFAULT_LANG ? {} : loadLanguage(currentLang);
  strings = { ...base, ...chosen };
  return currentLang;
}

// traduz uma chave, interpolando {variáveis}
function t(key, vars) {
  let s = strings[key] != null ? strings[key] : key;
  if (vars) {
    for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
  }
  return s;
}

function getLanguage() { return currentLang; }
function getStrings() { return strings; }

module.exports = { init, t, getLanguage, getStrings, availableLanguages };

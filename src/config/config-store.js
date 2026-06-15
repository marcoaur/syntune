/**
 * @module  config/config-store
 * @badge   🟪 CONFIG · FS · STATEFUL(secretsCache/secureMode) · SEALED-STATE
 * @role    Fonte única de config: separa preferências (config.json, legível) de segredos (secrets.enc, cifrado). Estado global selado no módulo; expõe init/leitura/escrita + getLibraryDir.
 * @inputs  config.json, secrets.enc, master.key (em userData)
 * @outputs config mesclado (prefs+segredos), gravação separada, pasta da biblioteca, flag secureMode
 * @deps    fs, path, electron(app), ./secrets
 * @notes   readConfig/writeConfig são injetados em gemini (factory) e i18n (init). secureMode decide cifrar vs plaintext. initSecrets migra chaves plaintext de instalações antigas.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const secrets = require('./secrets');

const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');
const MASTER_KEY_PATH = () => path.join(app.getPath('userData'), 'master.key');
const SECRETS_PATH = () => path.join(app.getPath('userData'), 'secrets.enc');

// Campos sensíveis que NÃO ficam em plaintext no config.json (vão p/ secrets.enc).
const SECRET_FIELDS = ['apiKey', 'lastfmApiKey', 'lastfmSecret', 'lastfmSessionKey', 'geniusToken'];

// ----- estado global selado (só este módulo enxerga) -----
let secureMode = false;  // cofre do SO disponível?
let masterKey = null;    // Buffer(32) — existe apenas em memória
let secretsCache = {};   // segredos decriptados, mesclados em readConfig()

function isSecureMode() { return secureMode; }

function persistSecrets() {
  try { fs.writeFileSync(SECRETS_PATH(), secrets.encryptSecrets(masterKey, secretsCache)); }
  catch (err) { console.warn('[secrets] falha ao gravar secrets.enc:', err.message); }
}

// Chamado no app ready: ativa o modo seguro, carrega os segredos e migra
// chaves plaintext que ainda estejam no config.json (instalações antigas).
function initSecrets() {
  try { secureMode = require('electron').safeStorage.isEncryptionAvailable(); } catch { secureMode = false; }
  if (!secureMode) {
    console.warn('[secrets] cofre do SO indisponível — chaves permanecem em plaintext no config.json.');
    return;
  }
  masterKey = secrets.loadOrCreateMasterKey(MASTER_KEY_PATH(), SECRETS_PATH());
  if (fs.existsSync(SECRETS_PATH())) {
    try {
      secretsCache = secrets.decryptSecrets(masterKey, fs.readFileSync(SECRETS_PATH()));
    } catch (err) {
      console.warn('[secrets] secrets.enc ilegível (perfil novo/arquivo adulterado):', err.message);
      secretsCache = {};
    }
  }
  // migração: move segredos plaintext do config.json para o cofre
  const raw = readRawConfig();
  const found = SECRET_FIELDS.filter((f) => raw[f]);
  if (found.length) {
    for (const f of found) { secretsCache[f] = raw[f]; delete raw[f]; }
    persistSecrets();
    try { fs.writeFileSync(CONFIG_PATH(), JSON.stringify(raw, null, 2), 'utf-8'); } catch { /* best-effort */ }
    console.log(`[secrets] ${found.length} segredo(s) migrado(s) para armazenamento cifrado.`);
  }
}

// config.json cru, sem os segredos (preferências apenas).
// Remove o BOM antes do parse: arquivos editados no Notepad vêm com BOM e
// quebrariam o JSON.parse, fazendo a config inteira cair nos defaults.
function readRawConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf-8').replace(/^﻿/, ''));
  } catch {
    return { apiKey: '', lastfmApiKey: '', geniusToken: '', model: 'gemini-2.5-flash', downloadFolder: '' };
  }
}

// visão completa: preferências + segredos decriptados
function readConfig() {
  const cfg = readRawConfig();
  if (secureMode) Object.assign(cfg, secretsCache);
  return cfg;
}

// Pasta onde a biblioteca de músicas é guardada.
// Usa a pasta configurada pelo usuário; se não houver (ou se o caminho estiver
// inacessível — unidade removida, caminho de rede, sem permissão), cai na pasta
// temporária para não travar o startup.
function getLibraryDir() {
  const cfg = readConfig();
  const configured = cfg.downloadFolder && cfg.downloadFolder.trim();
  const fallback = path.join(app.getPath('temp'), 'syntune', 'library');

  if (configured) {
    try {
      fs.mkdirSync(configured, { recursive: true });
      // Verifica acesso de leitura/escrita rapidamente
      fs.accessSync(configured, fs.constants.R_OK | fs.constants.W_OK);
      return configured;
    } catch {
      // Caminho inacessível: usa pasta temporária como fallback seguro
      console.warn('[getLibraryDir] Pasta configurada inacessível, usando fallback:', configured);
    }
  }

  try { fs.mkdirSync(fallback, { recursive: true }); } catch { /* já existe */ }
  return fallback;
}

// grava o config separando segredos (-> secrets.enc) de preferências (-> config.json)
function writeConfig(cfg) {
  if (secureMode) {
    const plain = { ...cfg };
    let touched = false;
    for (const f of SECRET_FIELDS) {
      if (f in plain) {
        if ((secretsCache[f] || '') !== (plain[f] || '')) { secretsCache[f] = plain[f]; touched = true; }
        delete plain[f];
      }
    }
    if (touched) persistSecrets();
    fs.writeFileSync(CONFIG_PATH(), JSON.stringify(plain, null, 2), 'utf-8');
  } else {
    fs.writeFileSync(CONFIG_PATH(), JSON.stringify(cfg, null, 2), 'utf-8');
  }
}

module.exports = { initSecrets, readRawConfig, readConfig, writeConfig, getLibraryDir, isSecureMode, SECRET_FIELDS };

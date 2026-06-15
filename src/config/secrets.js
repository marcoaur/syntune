/**
 * @module  config/secrets
 * @badge   🟪 CONFIG · CRYPTO(AES-256-GCM) · FS · PURE-ish
 * @role    Cripto em repouso dos segredos: master key (envelope via safeStorage do SO) + envelope AES-256-GCM (magic+iv+tag+ct). Sem estado de módulo — a key é injetada por parâmetro.
 * @inputs  caminhos master.key/secrets.enc, masterKey (Buffer 32), objeto de segredos / buffer cifrado
 * @outputs Buffer(masterKey), Buffer(envelope cifrado), objeto decriptado
 * @deps    crypto, fs, electron(safeStorage)
 * @notes   GCM: arquivo adulterado falha na verificação do authTag (não vira lixo). O formato/algoritmo é contrato de persistência — não alterar sem migração.
 */
const crypto = require('crypto');
const fs = require('fs');
const { safeStorage } = require('electron');

const SECRETS_MAGIC = Buffer.from('SYN1'); // cabeçalho + versão do formato

// Carrega a master key (decifrando via cofre do SO) ou cria uma nova de 32 bytes.
// Se o cofre não puder decifrar a key antiga (perfil do SO mudou), descarta os
// segredos antigos por design e gera uma nova — o usuário recola as chaves de API.
function loadOrCreateMasterKey(masterKeyPath, secretsPath) {
  const p = masterKeyPath;
  if (fs.existsSync(p)) {
    try {
      return Buffer.from(safeStorage.decryptString(fs.readFileSync(p)), 'base64');
    } catch {
      // Perfil do SO mudou (reinstalação, usuário novo): a chave antiga é
      // irrecuperável por design. Recomeça — o usuário recola as chaves de API.
      console.warn('[secrets] master.key irrecuperável; segredos serão re-solicitados.');
      try { fs.rmSync(secretsPath, { force: true }); } catch { /* ok */ }
    }
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(p, safeStorage.encryptString(key.toString('base64')));
  return key;
}

function encryptSecrets(masterKey, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf-8'), cipher.final()]);
  return Buffer.concat([SECRETS_MAGIC, iv, cipher.getAuthTag(), ct]);
}

function decryptSecrets(masterKey, buf) {
  if (!buf || buf.length < 33 || !buf.subarray(0, 4).equals(SECRETS_MAGIC)) return {};
  const iv = buf.subarray(4, 16);
  const tag = buf.subarray(16, 32);
  const ct = buf.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAuthTag(tag); // GCM: arquivo adulterado falha aqui, não vira lixo
  return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8'));
}

module.exports = { SECRETS_MAGIC, loadOrCreateMasterKey, encryptSecrets, decryptSecrets };

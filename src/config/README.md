# src/config — 🟪 Config & segredos

Fonte única de configuração. Separa **preferências** (legíveis em `config.json`) de **segredos** (cifrados em `secrets.enc`). Estado global selado dentro de `config-store` — ninguém mais toca `secretsCache`/`secureMode`.

## Mapa de arquivos

| Arquivo | Badge | Responsabilidade única |
|---------|-------|------------------------|
| `secrets.js` | 🟪 CONFIG · CRYPTO(AES-256-GCM) · PURE-ish | Cripto em repouso: master key (envelope via safeStorage do SO) + envelope AES-256-GCM. Sem estado — key injetada por parâmetro |
| `config-store.js` | 🟪 CONFIG · FS · STATEFUL · SEALED | Paths, `SECRET_FIELDS`, estado (secureMode/masterKey/secretsCache), `initSecrets`, `readConfig`/`writeConfig`/`readRawConfig`, `getLibraryDir`, `isSecureMode` |

## Fluxo de dados

```
app ready ─► initSecrets()
   │  safeStorage.isEncryptionAvailable()? ── não ─► secureMode=false (plaintext + aviso na UI)
   │  sim ▼
   │  secrets.loadOrCreateMasterKey(master.key, secrets.enc) ─► masterKey(Buffer32)
   │  secrets.decryptSecrets(masterKey, secrets.enc) ─► secretsCache
   │  migra chaves plaintext do config.json ─► secretsCache + persist
   ▼
readConfig() = config.json (prefs) + secretsCache (se secureMode)
writeConfig(cfg): SECRET_FIELDS ─► secrets.enc (cifrado);  resto ─► config.json
```

**Insumos:** `config.json`, `secrets.enc`, `master.key` (em `userData`).
**Saídas:** config mesclado, gravação separada prefs/segredos, pasta da biblioteca, flag `secureMode`.

## Contratos

- `secrets`: `loadOrCreateMasterKey(masterKeyPath, secretsPath)`, `encryptSecrets(masterKey, obj)`, `decryptSecrets(masterKey, buf)`, `SECRETS_MAGIC`. Deps: `crypto`, `fs`, `electron(safeStorage)`.
- `config-store`: `initSecrets, readRawConfig, readConfig, writeConfig, getLibraryDir, isSecureMode, SECRET_FIELDS`. Deps: `fs`, `path`, `electron(app)`, `./secrets`.
- **Injeção:** `readConfig`/`writeConfig` são passados a `gemini` (factory) e `i18n.init({...})`. Mesma instância (cache do require) → mesmo estado.

## Invariantes (segurança)

1. Segredos (`SECRET_FIELDS`) **nunca** em plaintext quando o cofre do SO existe.
2. Formato de `secrets.enc` (`SYN1` + iv + authTag + ct) é contrato de persistência — não alterar sem migração.
3. GCM: `secrets.enc` adulterado **falha** na verificação do authTag (não decifra lixo); `initSecrets` cai p/ `secretsCache={}`.
4. Master key irrecuperável (perfil do SO mudou) → descarta segredos por design; usuário recola as chaves.
5. `readRawConfig` remove BOM (`﻿`) antes do `JSON.parse` (arquivos do Notepad).

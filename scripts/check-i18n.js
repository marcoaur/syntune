// Verifica a paridade de chaves entre os dicionários de locales/.
// Falha (exit 1) se qualquer idioma tiver chave faltando ou sobrando em
// relação aos demais — evita texto cru de chave aparecendo na UI.
//
// Uso: node scripts/check-i18n.js

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'locales');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));

if (files.length < 2) {
  console.log(`[check-i18n] ${files.length} dicionário(s) — nada a comparar.`);
  process.exit(0);
}

const dicts = files.map((f) => ({
  file: f,
  keys: new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))))
}));

// união de todas as chaves
const all = new Set();
for (const d of dicts) for (const k of d.keys) all.add(k);

let failed = false;
for (const d of dicts) {
  const missing = [...all].filter((k) => !d.keys.has(k));
  if (missing.length) {
    failed = true;
    console.error(`\n[check-i18n] ${d.file} está sem ${missing.length} chave(s):`);
    for (const k of missing) console.error(`  - ${k}`);
  }
}

if (failed) {
  console.error('\n[check-i18n] FALHOU — sincronize os dicionários em locales/.');
  process.exit(1);
}
console.log(`[check-i18n] OK — ${files.length} dicionários, ${all.size} chaves em paridade.`);

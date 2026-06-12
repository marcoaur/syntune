// Script de build com auto-incremento de versão.
//
// Uso:
//   npm run build           -> incrementa o patch  (1.0.0 -> 1.0.1)
//   npm run build feature   -> incrementa o minor  (1.0.1 -> 1.1.0)
//   npm run build major     -> incrementa o major  (1.1.0 -> 2.0.0)
//
// Padrão de mercado: MAJOR.MINOR.PATCH (limites 99.999.999).

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');

const MAX = { major: 99, minor: 999, patch: 999 };

// 1) Descobre o tipo de incremento a partir do argumento
const arg = (process.argv[2] || '').toLowerCase();
let level = 'patch';
if (arg === 'ignore') level = 'ignore';
else if (arg === 'feature' || arg === 'minor') level = 'minor';
else if (arg === 'major') level = 'major';
else if (arg && arg !== 'patch') {
  console.error(`[build] Argumento desconhecido: "${arg}". Use: feature | major | ignore (ou nenhum para patch).`);
  process.exit(1);
}

// 2) Lê e valida a versão atual
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
const m = String(pkg.version || '0.0.0').match(/^(\d+)\.(\d+)\.(\d+)/);
if (!m) {
  console.error(`[build] Versão inválida em package.json: "${pkg.version}"`);
  process.exit(1);
}
let [major, minor, patch] = m.slice(1).map(Number);

// 3) Incrementa conforme o nível (zerando os números à direita)
if (level === 'ignore') {
  console.log(`[build] Versão (${level}): mantida em ${m[0]}`);
} else {
  if (level === 'major') { major += 1; minor = 0; patch = 0; }
  else if (level === 'minor') { minor += 1; patch = 0; }
  else { patch += 1; }

  if (major > MAX.major || minor > MAX.minor || patch > MAX.patch) {
    console.error(`[build] Versão fora do limite 99.999.999: ${major}.${minor}.${patch}`);
    process.exit(1);
  }

  const newVersion = `${major}.${minor}.${patch}`;
  pkg.version = newVersion;
  fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`[build] Versão (${level}): ${m[0]} -> ${newVersion}`);
}

// 4) Limpa artefatos e (re)constrói
const run = (cmd) => execSync(cmd, { cwd: ROOT, stdio: 'inherit', shell: true });
fs.rmSync(path.join(ROOT, 'node_modules'), { recursive: true, force: true });
fs.rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });
run('npm install');
run('npm run dist');

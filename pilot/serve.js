// Servidor estático mínimo (sem dependências) para rodar os pilotos.
// Necessário porque o Chrome bloqueia import de módulos ESM via file:// (CORS).
// Uso:  node pilot/serve.js   → http://localhost:8080/chord-line/vanilla/
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(8080, () => {
  console.log('Pilotos em:');
  console.log('  http://localhost:8080/chord-line/vanilla/');
  console.log('  http://localhost:8080/chord-line/lit/');
  console.log('  http://localhost:8080/chord-line/atomico/');
});

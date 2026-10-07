const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'harness-prototype.html';
  if (!/^harness-prototype(?:-v0\.[123])?\.html$/.test(name)) { res.writeHead(404); res.end(); return; }
  fs.readFile(path.join(__dirname, name), (error, content) => {
    res.writeHead(error ? 404 : 200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(error ? 'Not found' : content);
  });
}).listen(4173, '127.0.0.1', () => process.stdout.write('Prototype: http://127.0.0.1:4173/\n'));

/**
 * Tiny screenshot sink for automated visual inspection.
 * The game POSTs a data URL here; we write a PNG to tools/shots/.
 *   node tools/shotserver.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('tools/shots');
fs.mkdirSync(OUT, { recursive: true });

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (req.method !== 'POST') { res.writeHead(405).end('POST only'); return; }

  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 40e6) { req.destroy(); }
  });
  req.on('end', () => {
    try {
      const { name = 'shot', data } = JSON.parse(body);
      const b64 = String(data).replace(/^data:image\/\w+;base64,/, '');
      const safe = name.replace(/[^a-z0-9._-]/gi, '_');
      const file = path.join(OUT, `${safe}.png`);
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      console.log(`wrote ${file} (${(b64.length * 0.75 / 1024).toFixed(0)} KB)`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, file }));
    } catch (e) {
      console.error(e);
      res.writeHead(500).end(String(e));
    }
  });
});
server.listen(5181, () => console.log('shot server on http://localhost:5181'));

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomInt } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { attachRelay, clientIp, limits } = require('./relay.cjs');
const sessions = new Map();
const creations = new Map();
let relay;
const codes = new Map();
const token = () => randomBytes(24).toString('base64url');
const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const files = {
  '': ['public/index.html', 'text/html'],
  'app.js': ['public/app.js', 'text/javascript'],
  'i18n.js': ['public/i18n.js', 'text/javascript'],
  'style.css': ['public/style.css', 'text/css'],
  'reading-font/LiberationSans-Regular.ttf': ['node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf', 'font/ttf'],
  'reading-font/LiberationSans-Bold.ttf': ['node_modules/pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf', 'font/ttf'],
  'reading-font/LiberationSans-Italic.ttf': ['node_modules/pdfjs-dist/standard_fonts/LiberationSans-Italic.ttf', 'font/ttf'],
  'reading-font/LiberationSans-BoldItalic.ttf': ['node_modules/pdfjs-dist/standard_fonts/LiberationSans-BoldItalic.ttf', 'font/ttf'],
  'igor.png': ['public/igor.png', 'image/png'],
  'whereprompter.html': ['public/whereprompter.html', 'text/html'],
  'mammoth.js': ['node_modules/mammoth/mammoth.browser.min.js', 'text/javascript'],
  'zip.js': ['node_modules/jszip/dist/jszip.min.js', 'text/javascript'],
  'pdf.mjs': ['node_modules/pdfjs-dist/build/pdf.min.mjs', 'text/javascript'],
  'pdf.worker.min.mjs': ['node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'text/javascript']
};
const ttl = 15 * 60_000;
setInterval(() => {
  for (const [id, s] of sessions) if (!s.screen && !s.operator && Date.now() - s.seen > ttl) sessions.delete(id);
  for (const [code, entry] of codes) if (entry.expires <= Date.now()) codes.delete(code);
  for (const [ip, entry] of creations) if (entry.reset <= Date.now()) creations.delete(ip);
}, 60_000).unref();

async function handleRequest(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  const json = (status, body) => {
    res.writeHead(status, {'Content-Type':'application/json'});
    res.end(JSON.stringify(body));
  };
  try {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname.slice(1);
    const runtime = /^office-2\.7\.2\/(dist\/[\w.-]+\.js|wasm\/soffice\.(?:js|worker\.js|wasm|data|data\.js\.metadata))$/.exec(route);
    if (req.method === 'GET' && runtime) {
      const file = path.join(__dirname, 'node_modules', '@matbee', 'libreoffice-converter', runtime[1]);
      const info = await fs.stat(file).catch(() => null);
      if (!info?.isFile()) return json(404, {});
      const mime = file.endsWith('.wasm') ? 'application/wasm' :
        file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.writeHead(200, {'Content-Type':mime, 'Content-Length':info.size});
      await pipeline(createReadStream(file, {highWaterMark:32 * 1024}), res);
      return;
    }
    if (req.method === 'GET' && route === 'healthz') {
      return json(200, {ok:true, sessions:sessions.size, sockets:relay?.sockets() ?? 0,
        rssMiB:Math.round(process.memoryUsage.rss() / 1048576)});
    }
    if (req.method === 'GET' && route === 'api/qr') {
      const link = url.searchParams.get('link') || '';
      if (link.length > 512 || !/^https?:\/\//.test(link)) return json(400, {});
      const svg = require('qrcode/lib/renderer/svg-tag').render(
        require('qrcode/lib/core/qrcode').create(link), {margin:2}
      );
      res.writeHead(200, {'Content-Type':'image/svg+xml'});
      return res.end(svg);
    }
    if (req.method === 'GET' && Object.hasOwn(files, route)) {
      const [file, mime] = files[route];
      const filename = path.join(__dirname, file);
      const info = await fs.stat(filename);
      const headers = {
        'Content-Type':mime.startsWith('text/') ? mime + '; charset=utf-8' : mime,
        'Content-Length':info.size
      };
      if (route) {
        const etag = '"' + info.size.toString(16) + '-' + info.mtimeMs.toString(16) + '"';
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('ETag', etag);
        if (req.headers?.['if-none-match'] === etag) {
          res.writeHead(304);
          return res.end();
        }
      }
      if (info.size > 64 * 1024) {
        res.writeHead(200, headers);
        await pipeline(createReadStream(filename, {highWaterMark:32 * 1024}), res);
        return;
      }
      const bytes = await fs.readFile(filename);
      res.writeHead(200, headers);
      return res.end(bytes);
    }
    if (req.method !== 'POST') return json(404, {});
    if (route === 'api/new') {
      if (sessions.size >= limits.sessions) return json(503, {});
      if (limits.ipSessions) {
        const ip = clientIp(req);
        const now = Date.now();
        let entry = creations.get(ip);
        if (!entry || entry.reset <= now) { entry = {count:0, reset:now + 10 * 60_000}; creations.set(ip, entry); }
        if (++entry.count > limits.ipSessions) return json(429, {});
      }
      const id = token();
      const host = token();
      sessions.set(id, {host, seen:Date.now(), screen:null, operator:null});
      let code;
      do {
        code = Array.from({length:5}, () => alphabet[randomInt(alphabet.length)]).join('');
      } while (codes.has(code));
      codes.set(code, {id, expires:Date.now() + 5 * 60_000});
      return json(200, {id, host, code});
    }
    return json(404, {});
  } catch (error) {
    if (!res.headersSent) json(error instanceof SyntaxError ? 400 : 500, {});
    else res.end();
  }
}

function createServer() {
  const server = http.createServer({highWaterMark:16 * 1024}, handleRequest);
  relay = attachRelay(server, sessions, codes);
  return server;
}
if (require.main === module) {
  const server = createServer();
  server.listen(Number(process.env.PORT || 8787), process.env.HOST || '127.0.0.1');
  // SIGTERM (docker stop): chiude i collegamenti con garbo ed esce subito invece di attendere il timeout.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      relay?.shutdown();
      server.close();
      setTimeout(() => process.exit(0), 500).unref();
    });
  }
}
module.exports = { handleRequest, createServer };

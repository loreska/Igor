// Limiti per sessioni, connessioni e tentativi di codice (valori piccoli per poterli raggiungere).
process.env.IGOR_MAX_SESSIONS = '6';
process.env.IGOR_IP_SESSIONS = '4';
process.env.IGOR_IP_SOCKETS = '3';
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { createServer } = require('../server.cjs');
const server = createServer();
const live = new Set();
const open = (url, origin, ip) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url, {origin, headers:{'X-Forwarded-For':ip}});
  live.add(ws);
  ws.on('error', reject);
  ws.on('unexpected-response', (_, res) => resolve({denied:res.statusCode}));
  ws.on('open', () => resolve({ws}));
});
const closeCode = ws => new Promise(resolve => ws.once('close', code => resolve(code)));
(async () => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const host = '127.0.0.1:' + server.address().port;
  const origin = 'http://' + host;
  const url = 'ws://' + host + '/sync';
  const create = ip => fetch(origin + '/api/new', {method:'POST', headers:{'X-Forwarded-For':ip}});

  // Stato di salute.
  const health = await (await fetch(origin + '/healthz')).json();
  assert.equal(health.ok, true);

  // Sessioni per IP: la quinta richiesta dallo stesso IP viene rifiutata, un altro IP passa.
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await create('10.0.0.1')).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 429]);
  const legit = await (await create('10.0.0.2')).json();

  // Tetto globale: 5 sessioni esistono, la sesta è l'ultima, la settima no.
  assert.equal((await create('10.0.0.3')).status, 200);
  assert.equal((await create('10.0.0.4')).status, 503);

  // Connessioni per IP: la quarta dallo stesso IP viene rifiutata.
  const sockets = [];
  for (let i = 0; i < 3; i++) sockets.push((await open(url, origin, '10.0.0.9')).ws);
  assert.equal((await open(url, origin, '10.0.0.9')).denied, 403);
  assert.ok((await open(url, origin, '10.0.0.10')).ws);

  // Codici sbagliati da un IP non bloccano gli altri.
  let throttled = false;
  for (let i = 0; i < 30 && !throttled; i++) {
    const { ws } = await open(url, origin, '10.0.0.50' + (i % 1));
    ws.send(JSON.stringify({type:'join', role:'viewer', code:'ZZZZZ'}));
    throttled = (await closeCode(ws)) === 4029;
  }
  assert.ok(throttled, 'un IP che prova codici a caso deve essere rallentato');
  const { ws: viewer } = await open(url, origin, '10.0.0.70');
  const joined = new Promise(resolve => viewer.on('message', data => { const m = JSON.parse(data); if (m.type === 'ready') resolve(m); }));
  viewer.send(JSON.stringify({type:'join', role:'viewer', code:legit.code}));
  assert.ok((await joined).viewerKey, 'un utente con codice valido deve poter entrare');
  console.log('Limiti per sessioni, connessioni e codici verificati.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const ws of live) ws.terminate();
  server.closeAllConnections();
  server.close();
});

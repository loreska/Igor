// Prova di carico contro un Igor già in esecuzione (processo separato dal server).
// Uso: node test/load.cjs [coppie=300] [url=http://127.0.0.1:8787] [secondi=20] [pid_server]
// Simula coppie schermo+operatore con lo stato inviato ~5 volte al secondo.
// Non eseguirla sul VPS di produzione: lanciala da un'altra macchina. Dallo stesso IP servono i limiti per IP
// disattivati sul server di prova: IGOR_IP_SESSIONS=0 IGOR_IP_SOCKETS=0 (e IGOR_MAX_SESSIONS alto).
const { WebSocket } = require('ws');
const fs = require('node:fs');
const pairs = Number(process.argv[2] || 300);
const base = new URL(process.argv[3] || 'http://127.0.0.1:8787');
const seconds = Number(process.argv[4] || 20);
const pid = process.argv[5];
const wsUrl = (base.protocol === 'https:' ? 'wss://' : 'ws://') + base.host + base.pathname.replace(/\/?$/, '/') + 'sync';
const rss = () => { try { return Math.round(Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync('/proc/' + pid + '/status', 'utf8'))[1]) / 1024); } catch { return '?'; } };
const origin = base.origin;
const cpuTicks = () => { try { const f = fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1].split(' '); return Number(f[11]) + Number(f[12]); } catch { return 0; } };
const state = JSON.stringify({type:'state', status:'Prova', content:{revision:1, text:'x'.repeat(400)}, offset:0, max:1000, open:true});
let received = 0, failed = 0;
function open(join) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {origin});
    ws.on('open', () => ws.send(JSON.stringify({type:'join', ...join})));
    ws.on('message', data => { received++; const m = JSON.parse(data); if (m.type === 'ready') resolve({ws, auth:m}); });
    ws.on('error', reject);
    ws.on('close', () => { failed++; });
  });
}
(async () => {
  console.log('RSS server iniziale:', rss(), 'MiB');
  const live = [];
  for (let i = 0; i < pairs; i += 25) {
    await Promise.all(Array.from({length:Math.min(25, pairs - i)}, async () => {
      const res = await fetch(base.origin + base.pathname.replace(/\/?$/, '/') + 'api/new', {method:'POST'});
      if (!res.ok) throw new Error('api/new ' + res.status);
      const session = await res.json();
      const screen = await open({...session, role:'screen'});
      const op = await open({code:session.code, role:'viewer'});
      live.push([screen.ws, op.ws]);
    }));
  }
  console.log('Coppie attive:', live.length, '| RSS server:', rss(), 'MiB');
  const cpu0 = cpuTicks(), t0 = Date.now();
  const timer = setInterval(() => { for (const [s] of live) if (s.readyState === 1) s.send(state); }, 200);
  await new Promise(r => setTimeout(r, seconds * 1000));
  clearInterval(timer);
  const cpu = (cpuTicks() - cpu0) / 100 / ((Date.now() - t0) / 1000) * 100;
  console.log('Dopo', seconds, 's di lettura simulata | RSS server:', rss(), 'MiB | messaggi ricevuti:', received, '| chiusure inattese:', failed, '| CPU server: ' + cpu.toFixed(0) + '% di un core');
  for (const pair of live) pair.forEach(ws => ws.close());
  await new Promise(r => setTimeout(r, 1500));
  console.log('A sessioni chiuse | RSS server:', rss(), 'MiB');
  process.exit(0);
})().catch(e => { console.error('ERRORE', e.message); process.exit(1); });

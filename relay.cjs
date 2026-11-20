const { WebSocketServer, WebSocket } = require('ws');
const { randomBytes } = require('node:crypto');

// Limiti configurabili da variabili d'ambiente (0 = nessun limite dove indicato).
const number = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
};
const limits = {
  sessions: number('IGOR_MAX_SESSIONS', 1000),          // coppie schermo+operatore contemporanee
  ipSessions: number('IGOR_IP_SESSIONS', 100),          // nuove sessioni per IP ogni 10 minuti (0 = illimitate)
  ipSockets: number('IGOR_IP_SOCKETS', 200)             // connessioni aperte per IP (0 = illimitate)
};
limits.sockets = number('IGOR_MAX_SOCKETS', limits.sessions * 2 + 200);

// IP del client. Dietro Caddy vale l'ultimo valore di X-Forwarded-For (quello aggiunto dal proxy,
// non falsificabile dal client). IPv6 raggruppato per /64.
function clientIp(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',').pop().trim();
  const ip = forwarded || req.socket?.remoteAddress || 'unknown';
  return ip.includes(':') && !ip.includes('.') ? ip.split(':').slice(0, 4).join(':') : ip;
}

// Secchiello di gettoni per IP (tentativi di codice sbagliati).
function bucketFor(map, ip, burst, perMs, now) {
  let bucket = map.get(ip);
  if (!bucket) { bucket = {tokens:burst, at:now}; map.set(ip, bucket); }
  bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.at) / perMs);
  bucket.at = now;
  return bucket;
}

function attachRelay(server, sessions, codes) {
  const relay = new WebSocketServer({noServer:true, maxPayload:1_500_000, perMessageDeflate:false});
  const maxSockets = limits.sockets;
  const socketsByIp = new Map();
  const attemptsByIp = new Map();
  let queuedBytes = 0;
  let codeAttempts = 60;
  let lastAttempt = Date.now();

  function send(socket, message) {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    const bytes = Buffer.byteLength(payload);
    if (socket.bufferedAmount + bytes > 1_600_000 || queuedBytes + bytes > 8 * 1024 * 1024) {
      socket.terminate();
      return;
    }
    queuedBytes += bytes;
    socket.send(payload, () => { queuedBytes -= bytes; });
  }

  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const allowed = origin === 'https://' + req.headers.host || origin === 'http://' + req.headers.host;
    const ip = clientIp(req);
    if (req.url !== '/sync' || !allowed || relay.clients.size >= maxSockets ||
        (limits.ipSockets && (socketsByIp.get(ip) || 0) >= limits.ipSockets)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    relay.handleUpgrade(req, socket, head, ws => {
      ws.ip = ip;
      socketsByIp.set(ip, (socketsByIp.get(ip) || 0) + 1);
      ws.on('close', () => {
        const left = (socketsByIp.get(ip) || 1) - 1;
        if (left > 0) socketsByIp.set(ip, left); else socketsByIp.delete(ip);
      });
      relay.emit('connection', ws);
    });
  });

  relay.on('connection', socket => {
    let session;
    let role;
    const deadline = setTimeout(() => socket.terminate(), 5000);
    deadline.unref();
    socket.alive = true;
    socket.on('error', () => {});
    socket.on('pong', () => { socket.alive = true; });
    const other = () => session?.[role === 'screen' ? 'operator' : 'screen'];
    socket.on('close', () => {
      clearTimeout(deadline);
      if (session?.[role] === socket) {
        session[role] = undefined;
        session.seen = Date.now();
        send(other(), {type:'peer', online:false});
      }
    });
    socket.on('message', (buffer, binary) => {
      if (binary) return socket.close(1003);
      const payload = buffer.toString('utf8');
      let data;
      try { data = JSON.parse(payload); } catch { return socket.close(1007); }
      if (!data || typeof data !== 'object') return socket.close(1007);
      if (!session) {
        const viewer = data.role === 'viewer';
        let id = data.id;
        let code;
        if (viewer && !data.viewerKey) {
          const now = Date.now();
          codeAttempts = Math.min(60, codeAttempts + (now - lastAttempt) / 50);
          lastAttempt = now;
          // Tentativi sbagliati: un secchiello per IP (così chi prova codici a caso non blocca gli altri)
          // più quello globale come rete di sicurezza.
          const mine = bucketFor(attemptsByIp, socket.ip, 20, 2000, now);
          code = typeof data.code === 'string' && data.code.length === 5 ? data.code.toUpperCase() : '';
          const entry = codes.get(code);
          id = entry?.expires > now ? entry.id : undefined;
          if (mine.tokens < 1 || codeAttempts < 1) return socket.close(4029, 'Riprova tra poco');
          if (!id) { codeAttempts--; mine.tokens--; }
        }
        const requested = sessions.get(id);
        if (data.type !== 'join' || !requested ||
            (data.role !== 'screen' && data.role !== 'operator' && !viewer) ||
            (viewer && !code && (!requested.viewerKey || requested.viewerKey !== data.viewerKey)) ||
            (viewer && code && requested.viewerKey) ||
            (data.role === 'operator' && requested.viewerKey) ||
            (data.role === 'screen' && requested.host !== data.host)) {
          return socket.close(4004, 'Sessione non disponibile');
        }
        session = requested;
        role = viewer ? 'operator' : data.role;
        if (viewer && code) {
          codes.delete(code);
          session.viewerKey = randomBytes(24).toString('base64url');
        }
        clearTimeout(deadline);
        const previous = session[role];
        session[role] = socket;
        if (previous) previous.terminate();
        send(socket, {type:'ready', id:viewer ? id : undefined, viewerKey:viewer ? session.viewerKey : undefined});
        send(socket, {type:'peer', online:Boolean(other())});
        if (other()) send(other(), {type:'peer', online:true});
        return;
      }
      if (session[role] !== socket) return;
      if (data.type === 'signal' && buffer.length <= 32_768) return send(other(), payload);
      if (role === 'screen' && (data.type === 'state' || data.type === 'edit-result')) return send(other(), payload);
      if (role === 'operator' && data.type === 'control' && buffer.length <= 400_000) send(other(), payload);
    });
  });
  const heartbeat = setInterval(() => {
    for (const socket of relay.clients) {
      if (!socket.alive) socket.terminate();
      else { socket.alive = false; socket.ping(); }
    }
    const now = Date.now();
    for (const [ip, bucket] of attemptsByIp) if (now - bucket.at > 60_000) attemptsByIp.delete(ip);
  }, 20_000);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));
  return {
    sockets: () => relay.clients.size,
    // Chiusura ordinata: i client si riconnettono da soli appena il servizio torna su.
    shutdown() { for (const socket of relay.clients) socket.close(1001, 'Riavvio del servizio'); }
  };
}
module.exports = {attachRelay, clientIp, limits};

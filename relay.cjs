const { WebSocketServer, WebSocket } = require('ws');
const { randomBytes } = require('node:crypto');

function attachRelay(server, sessions, codes) {
  const relay = new WebSocketServer({noServer:true, maxPayload:1_500_000, perMessageDeflate:false});
  const maxSockets = 1200;
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
    if (req.url !== '/sync' || !allowed || relay.clients.size >= maxSockets) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    relay.handleUpgrade(req, socket, head, ws => relay.emit('connection', ws));
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
          code = typeof data.code === 'string' && data.code.length === 5 ? data.code.toUpperCase() : '';
          const entry = codes.get(code);
          id = entry?.expires > now ? entry.id : undefined;
          if (codeAttempts < 1) return socket.close(4029, 'Riprova tra poco');
          if (!id) codeAttempts--;
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
  }, 20_000);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));
}
module.exports = {attachRelay};

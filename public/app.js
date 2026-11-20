const $ = id => document.getElementById(id);
const buttons = {
  play:'▶ Avvia', pause:'❚❚ Pausa', slower:'− Lento', faster:'+ Veloce',
  back:'↑ Indietro', forward:'↓ Avanti', home:'⤒ Inizio',
  prev:'‹ Slide', next:'Slide ›', smaller:'A−', larger:'A+'
};
// Tasti di tastiere, pedali, clicker e telecomandi Bluetooth che si presentano come tastiera.
const keyCommands = {
  ' ':'toggle', Enter:'toggle', '.':'toggle', b:'toggle', MediaPlayPause:'toggle', MediaPlay:'toggle', MediaPause:'toggle',
  ArrowUp:'back', ArrowDown:'forward',
  ArrowRight:'next', PageDown:'next', MediaTrackNext:'next',
  ArrowLeft:'prev', PageUp:'prev', MediaTrackPrevious:'prev',
  '+':'faster', '=':'faster', '-':'slower', Home:'home'
};
const commandLabels = {
  toggle:'Avvia / Pausa', back:'Scorri indietro', forward:'Scorri avanti', next:'Avanti (slide o scorri)',
  smaller:'Riduci testo', larger:'Ingrandisci testo', prev:'Indietro (slide o scorri)', faster:'Più veloce', slower:'Più lento', home:'Torna all’inizio'
};
// I tasti del telecomando non devono scattare mentre si scrive, né attivare per sbaglio un pulsante a fuoco.
function keyBlocked(event) {
  const target = event.target;
  if (event.ctrlKey || event.metaKey || event.altKey) return true;
  if (target.closest?.('input:not([type=checkbox]), textarea, select, a, [contenteditable]')) return true;
  return [' ', 'Enter'].includes(event.key) && Boolean(target.closest?.('button, input[type=checkbox]'));
}
const buttonHints = {
  play:'Avvia la lettura (Spazio)', pause:'Metti in pausa (Spazio)',
  slower:'Rallenta lo scorrimento (−)', faster:'Accelera lo scorrimento (+)',
  back:'Scorri indietro (↑)', forward:'Scorri avanti (↓)', home:'Torna all’inizio del copione',
  prev:'Slide precedente (←)', next:'Slide successiva (→)',
  smaller:'Riduci la dimensione del testo', larger:'Aumenta la dimensione del testo'
};
async function api(route, body = {}) {
  const response = await fetch('api/' + route, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
    signal:AbortSignal.timeout(3000)
  });
  if (!response.ok) throw new Error('Sessione non disponibile');
  return response.json();
}
function connectPair(join, receive, changed, expired, ready = () => {}) {
  let ws;
  let peer;
  let channel;
  let online = false;
  let retry = 350;
  let pieces = '';
  let stopped = false;
  function report() {
    changed(channel?.readyState === 'open' ? 'direct' : online ? 'relay' : 'offline');
  }
  function signal(message) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type:'signal', ...message}));
  }
  function stopDirect() {
    const old = peer;
    peer = channel = undefined;
    pieces = '';
    old?.close();
  }
  function useChannel(next) {
    channel = next;
    next.onopen = () => { if (next === channel) report(); };
    next.onclose = () => { if (next === channel) { stopDirect(); report(); } };
    next.onmessage = event => {
      if (next !== channel || typeof event.data !== 'string') return;
      const part = event.data;
      pieces += part.slice(1);
      if (pieces.length > 1_500_000) { stopDirect(); report(); return; }
      if (part[0] === '+') return;
      const payload = pieces;
      pieces = '';
      try { receive(JSON.parse(payload)); } catch {}
    };
  }
  function makePeer() {
    const connection = new RTCPeerConnection();
    peer = connection;
    connection.ondatachannel = event => { if (connection === peer) useChannel(event.channel); };
    connection.onconnectionstatechange = () => {
      if (connection !== peer) return;
      if (['failed','closed','disconnected'].includes(connection.connectionState)) { stopDirect(); report(); }
    };
    return connection;
  }
  async function publishDescription(connection, description) {
    await connection.setLocalDescription(description);
    await new Promise(resolve => {
      if (connection.iceGatheringState === 'complete') return resolve();
      const finish = () => {
        clearTimeout(timer);
        connection.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => { if (connection.iceGatheringState === 'complete') finish(); };
      const timer = setTimeout(finish, 1500);
      connection.addEventListener('icegatheringstatechange', check);
    });
    if (connection === peer) signal({description:connection.localDescription});
  }
  async function negotiate(data) {
    if (!globalThis.RTCPeerConnection) return;
    try {
      if (data.type === 'peer' && data.online && join.role === 'screen') {
        const connection = makePeer();
        useChannel(connection.createDataChannel('igor'));
        await publishDescription(connection, await connection.createOffer());
      } else if (data.description?.type === 'offer' && join.role === 'operator') {
        stopDirect();
        const connection = makePeer();
        await connection.setRemoteDescription(data.description);
        await publishDescription(connection, await connection.createAnswer());
      } else if (data.description?.type === 'answer' && join.role === 'screen') {
        await peer?.setRemoteDescription(data.description);
      }
    } catch { report(); }
  }
  function open() {
    const url = new URL('sync', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(url);
    ws.onopen = () => ws.send(JSON.stringify({type:'join', ...join}));
    ws.onmessage = event => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type === 'ready') { retry = 350; ready(data); return; }
      if (data.type === 'peer') {
        online = data.online;
        if (!online || channel?.readyState !== 'open') {
          stopDirect();
          report();
          if (online) negotiate(data);
        }
      } else if (data.type === 'signal') negotiate(data);
      else if (channel?.readyState !== 'open') receive(data);
    };
    ws.onclose = event => {
      if (stopped) return;
      online = false;
      if (channel?.readyState !== 'open') { stopDirect(); report(); }
      if (event.code === 4004 || event.code === 4029) { expired(event.code); return; }
      setTimeout(() => { if (!stopped) open(); }, retry + Math.random() * 300);
      retry = Math.min(8000, retry * 2);
    };
  }
  open();
  const send = message => {
    const payload = JSON.stringify(message);
    if (channel?.readyState === 'open') {
      if (channel.bufferedAmount > 1_600_000) return false;
      try {
        for (let start = 0; start < payload.length;) {
          let end = Math.min(payload.length, start + 12_000);
          const last = payload.charCodeAt(end - 1);
          if (end < payload.length && last >= 0xd800 && last <= 0xdbff) end--;
          channel.send((end < payload.length ? '+' : '=') + payload.slice(start, end));
          start = end;
        }
        return true;
      } catch { stopDirect(); report(); return false; }
    }
    if (!online || ws?.readyState !== WebSocket.OPEN || ws.bufferedAmount > 1_600_000) return false;
    ws.send(payload);
    return true;
  };
  send.close = () => {
    stopped = true;
    stopDirect();
    ws?.close();
  };
  return send;
}
function controls(container, action, keys = Object.keys(buttons)) {
  container.classList.add('controls');
  for (const key of keys) {
    const button = document.createElement('button');
    button.textContent = buttons[key];
    button.dataset.key = key;
    button.title = button.ariaLabel = buttonHints[key];
    button.onclick = event => {
      action(key);
      if (event.detail) button.blur(); // dopo un clic il focus non deve bloccare i tasti del telecomando
    };
    container.append(button);
  }
}
function readingTap(onSingle, onDouble) {
  let waiting;
  function cancel() {
    clearTimeout(waiting);
    waiting = undefined;
  }
  return {
    cancel,
    tap() {
      if (waiting !== undefined) {
        cancel();
        onDouble();
      } else {
        waiting = setTimeout(() => {
          waiting = undefined;
          onSingle();
        }, 290);
      }
    }
  };
}

function showReadingTimer(element, seconds, mirroredX = false, mirroredY = false) {
  element.hidden = seconds == null;
  if (seconds == null) return;
  const value = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' +
    String(seconds % 60).padStart(2, '0');
  if (element.textContent !== value) element.textContent = value;
  element.classList.toggle('timer-flip-x', mirroredX);
  element.classList.toggle('timer-flip-y', mirroredY);
}

function showCountdown(element, value) {
  if (!value) { element.hidden = true; return; }
  if (!element.hidden && element.textContent === String(value)) return;
  const number = document.createElement('span');
  number.textContent = value;
  element.replaceChildren(number);
  element.hidden = false;
}
function copyMarkup(target, html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const allowed = new Set(['P','H1','H2','H3','H4','H5','H6','STRONG','EM','B','I','U','BR','UL','OL','LI','SUP','SUB','TABLE','THEAD','TBODY','TR','TD','TH']);
  function append(parent, children) {
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) parent.append(child.textContent);
      else if (allowed.has(child.tagName)) {
        const el = document.createElement(child.tagName);
        append(el, child.childNodes);
        parent.append(el);
      } else if (child.tagName === 'A') append(parent, child.childNodes);
    }
  }
  target.replaceChildren();
  append(target, doc.body.childNodes);
}
const momanService = '00001000-e619-419b-bc43-821e711009b7';
const momanReport = '00001002-e619-419b-bc43-821e711009b7';
const momanButtonCommands = [[0x01,'momanA'], [0x02,'smaller'], [0x04,'larger'], [0x08,'momanY'], [0x20,'home'], [0x40,'toggle']];

function resolveMomanCommand(command, view) {
  const slides = view === 'slide' || view === 'both' || view === 'notes';
  if (command === 'momanY') return slides ? 'next' : 'faster';
  if (command === 'momanA') return slides ? 'prev' : 'slower';
  return command;
}

function decodeMomanReport(value) {
  if (value.byteLength < 7 || value.getUint8(0) !== 0xa1 || value.getUint8(1) !== 0x06) return null;
  function axis(byte) {
    const centered = byte - 128;
    const span = centered < 0 ? 128 : 127;
    return Math.sign(centered) * Math.max(0, Math.abs(centered) - 20) / (span - 20);
  }
  return {x:axis(value.getUint8(2)), y:axis(value.getUint8(3)), buttons:value.getUint8(6)};
}

function attachMoman(connectButtons, statuses, onInput) {
  if (!isSecureContext || !navigator.bluetooth) return;
  let device;
  let characteristic;
  let lastMask;
  let lastDirection = 0;
  let busy = false;
  function update(label, message) {
    for (const button of connectButtons) {
      button.textContent = label;
      button.disabled = busy;
    }
    for (const status of statuses) status.textContent = message;
  }
  function notification(event) {
    const report = decodeMomanReport(event.target.value);
    if (!report) return;
    const pressed = lastMask === undefined ? 0 : report.buttons & ~lastMask;
    const commands = momanButtonCommands.filter(([bit]) => pressed & bit).map(([,command]) => command);
    const direction = Math.abs(report.y) < .25 && Math.abs(report.x) >= .55 ? Math.sign(report.x) : 0;
    if (direction && direction !== lastDirection) commands.push(direction < 0 ? 'prev' : 'next');
    lastMask = report.buttons;
    lastDirection = direction;
    onInput(report.y, commands);
  }
  function disconnected() {
    characteristic?.removeEventListener('characteristicvaluechanged', notification);
    characteristic = undefined;
    lastMask = undefined;
    lastDirection = 0;
    onInput(0, []);
    update('Collega Moman', 'Telecomando disconnesso.');
  }
  for (const button of connectButtons) button.onclick = async () => {
    if (busy) return;
    if (device?.gatt.connected) { device.gatt.disconnect(); return; }
    device = undefined;
    busy = true;
    update('Collega Moman', 'Collegamento Bluetooth in corso…');
    try {
      device = await navigator.bluetooth.requestDevice({
        acceptAllDevices:true, optionalServices:[momanService]
      });
      device.addEventListener('gattserverdisconnected', disconnected, {once:true});
      const gatt = await device.gatt.connect();
      const service = await gatt.getPrimaryService(momanService);
      characteristic = await service.getCharacteristic(momanReport);
      characteristic.addEventListener('characteristicvaluechanged', notification);
      await characteristic.startNotifications();
      busy = false;
      update('Scollega Moman', 'Moman collegato.');
    } catch (error) {
      if (device?.gatt.connected) device.gatt.disconnect();
      busy = false;
      update('Collega Moman', error.name === 'NotFoundError' ?
        (device ? 'Il dispositivo selezionato non espone il servizio BLE Moman.' : 'Nessun dispositivo selezionato.') :
        'Collegamento non riuscito. Scollega il Moman dalle altre app e riprova.');
    }
  };
  update('Collega Moman', '');
}

function revealMomanOnClicks(surface, controls) {
  if (!isSecureContext || !navigator.bluetooth) return;
  let clicks = 0;
  let lastClick = -Infinity;
  surface.addEventListener('click', event => {
    if (!controls.hidden || event.target.closest('button, input, select, label, a')) return;
    const now = performance.now();
    clicks = now - lastClick <= 500 ? clicks + 1 : 1;
    lastClick = now;
    if (clicks === 5) {
      clicks = 0;
      controls.hidden = false;
    }
  });
}

const remoteControls = setupRemoteControls();
const gameDialog = $('igorGame');
const gameHost = $('igorGameFrame');
const creditsDialog = $('igorCredits');
let iconClicks = 0;
let iconTimer;
$('igorIcon').addEventListener('click', () => {
  if (gameDialog.open || creditsDialog.open) return;
  clearTimeout(iconTimer);
  if (++iconClicks < 3) {
    iconTimer = setTimeout(() => {
      iconClicks = 0;
      creditsDialog.showModal();
    }, 420);
    return;
  }
  iconClicks = 0;
  const frame = document.createElement('iframe');
  frame.title = 'WHEREPROMTER? THEREPROMPTER!';
  frame.src = 'whereprompter.html';
  gameHost.append(frame);
  gameDialog.showModal();
});
gameDialog.addEventListener('close', () => gameHost.replaceChildren());
revealMomanOnClicks($('readingOptions'), $('momanSetupControls'));
revealMomanOnClicks($('viewerSettingsTitle'), $('momanControls'));
$('viewerSettings').addEventListener('close', () => { $('momanControls').hidden = true; });
const linkParams = new URLSearchParams(location.hash.slice(1));
const remoteId = linkParams.get('operator');
if (new URLSearchParams(location.search).has('schermo')) {
  $('setup').hidden = true;
  $('joinScreen').hidden = false;
  function joinViewer(code) {
    const normalized = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(normalized)) return;
    const url = new URL(location.href);
    url.hash = 'viewer=' + normalized;
    history.replaceState(null, '', url);
    const auth = {role:'viewer', code:normalized};
    const cacheKey = 'igor-viewer-' + normalized;
    try {
      const saved = JSON.parse(sessionStorage.getItem(cacheKey));
      if (saved?.id && saved.viewerKey) Object.assign(auth, saved);
    } catch {}
    $('joinScreen').hidden = true;
    runReceiver(auth, true, data => {
      Object.assign(auth, {id:data.id, viewerKey:data.viewerKey});
      try { sessionStorage.setItem(cacheKey, JSON.stringify({id:data.id, viewerKey:data.viewerKey})); } catch {}
    }, error => {
      try { sessionStorage.removeItem(cacheKey); } catch {}
      $('remote').hidden = true;
      $('joinScreen').hidden = false;
      $('joinStatus').textContent = error === 4029 ? 'Troppi tentativi. Riprova tra poco.' :
        'Codice non valido, scaduto o già utilizzato. Generane uno nuovo dai comandi.';
    });
  }
  $('joinForm').onsubmit = event => {
    event.preventDefault();
    joinViewer($('screenCode').value);
  };
  if (linkParams.has('viewer')) joinViewer(linkParams.get('viewer'));
} else if (remoteId) {
  runReceiver({id:remoteId, role:'operator'});
} else {
  setup();
}

function runReceiver(auth, display = false, ready, expired) {
  $('setup').hidden = true;
  $('remote').hidden = false;
  $('remote').classList.toggle('viewer-mode', display);
  let connected = false;
  let commands = [];
  let revision;
  let state;
  let seek;
  let pending;
  let pointer;
  let controlInterval;
  let momanRate = 0;
  let momanSeen = 0;
  let sentMomanRate = 0;
  const viewerSettings = $('viewerSettings');
  let edit;
  let editRevision;
  let editable;
  let scale = 1;
  let offset = 0;
  const monitor = $('monitor');
  const stage = $('monitorStage');
  const copy = $('monitorCopy');
  const canvas = $('monitorSlide');
  const seekId = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
  function place(element, rect) {
    Object.assign(element.style, {
      left:rect.x + 'px', top:rect.y + 'px', width:rect.w + 'px', height:rect.h + 'px'
    });
  }
  function position(value) {
    offset = value;
    copy.style.transform = 'translateY(' + (-value) + 'px)';
  }
  function layout() {
    if (!state?.width || !state.height) return;
    scale = Math.min(monitor.clientWidth / state.width, monitor.clientHeight / state.height);
    place(stage, {
      x:(monitor.clientWidth - state.width * scale) / 2,
      y:(monitor.clientHeight - state.height * scale) / 2,
      w:state.width, h:state.height
    });
    stage.style.transform = 'scale(' + scale + ')';
    if (display) stage.style.transform += ' translate(' + (state.mirrorX ? '100%' : '0') +
      ',' + (state.mirrorY ? '100%' : '0') + ') scale(' + (state.mirrorX ? -1 : 1) + ',' +
      (state.mirrorY ? -1 : 1) + ')';
    place($('monitorViewport'), state.viewport);
    $('monitorViewport').hidden = state.view === 'slide';
    canvas.hidden = !state.slide || !canvas.hasAttribute('src');
    if (state.slide) place(canvas, state.slide);
    copy.style.fontSize = state.font + 'px';
    copy.style.padding = state.padding;
  }
  const observer = new ResizeObserver(layout);
  observer.observe(monitor);
  function dragTo(value, held = false) {
    if (!connected || !state?.viewport.w || state.revision !== revision) return;
    const target = Math.min(state.max, Math.max(0, value));
    copy.style.transition = 'none';
    position(target);
    seek = {offset:target, revision, id:seekId(), held};
    pending = {...seek, until:performance.now() + 4000};
  }
  let gamepadRate = 0;
  let gamepadSeen = -Infinity;
  remoteControls.connect(() => state?.view || 'text', (command, axis) => {
    if (!connected || !state?.open || viewerSettings.open || document.querySelector('dialog[open]')) return;
    if (axis !== undefined) {
      gamepadRate = axis;
      gamepadSeen = performance.now();
    }
    if (command && commands.length < 8) commands.push(command);
  });
  const taps = readingTap(
    () => { if (connected && state?.open && !viewerSettings.open) commands.push('toggle'); },
    () => { if (!viewerSettings.open) viewerSettings.showModal(); }
  );
  document.addEventListener('keydown', event => {
    const command = remoteControls.key(event);
    if (!command || $('remote').hidden || document.querySelector('dialog[open]') || keyBlocked(event)) return;
    event.preventDefault();
    if (command === 'toggle' && (event.repeat || !state?.open)) return;
    if (connected && commands.length < 8) commands.push(command);
  });
  monitor.onpointerdown = event => {
    if (!connected || !state?.open || (!display && !state.viewport.w) ||
        pointer || !event.isPrimary || event.button !== 0) return;
    pointer = {id:event.pointerId, x:event.clientX, start:event.clientY, offset, downAt:performance.now(), moved:false, dragging:false};
    monitor.setPointerCapture(event.pointerId);
    if (!display) dragTo(offset, true);
  };
  monitor.onpointermove = event => {
    if (pointer?.id !== event.pointerId || scale <= 0) return;
    const dy = pointer.start - event.clientY;
    if (Math.abs(dy) >= 8 || Math.abs(pointer.x - event.clientX) >= 8) {
      pointer.moved = true;
      taps.cancel();
    }
    if (display && (!state?.viewport.w || (!pointer.dragging && Math.abs(dy) < 8))) return;
    pointer.dragging = true;
    dragTo(pointer.offset + dy / scale * (display && state.mirrorY ? -1 : 1), true);
  };
  function finishPointer(event, tap) {
    if (pointer?.id !== event.pointerId) return;
    const last = pointer;
    pointer = null;
    if (last.dragging || !display) dragTo(offset);
    else if (tap && !last.moved && performance.now() - last.downAt < 350) taps.tap();
  }
  monitor.onpointerup = event => finishPointer(event, true);
  monitor.onpointercancel = monitor.onlostpointercapture = event => finishPointer(event, false);
  $('remoteEditor').ontoggle = () => {
    if (!$('remoteEditor').open || !editable) return;
    $('remoteDraft').value = editable.text;
    editRevision = revision;
    $('editStatus').textContent = editable.markup ? 'Le modifiche dal telefono salvano il copione come testo semplice.' : '';
  };
  $('sendEdit').onclick = () => {
    if (!connected || editRevision === undefined) return;
    if (editRevision !== revision) {
      $('editStatus').textContent = 'Il testo è cambiato. Chiudi e riapri l’editor prima di inviare.';
      return;
    }
    edit = {revision, text:$('remoteDraft').value};
    $('editStatus').textContent = 'Invio in corso…';
  };
  monitor.addEventListener('wheel', event => {
    if (!connected || !state?.viewport.w || scale <= 0) return;
    event.preventDefault();
    dragTo(offset + event.deltaY / scale);
  }, {passive:false});
  if (!display) controls($('remoteControls'), key => {
    if (connected && commands.length < 8) commands.push(key);
  });
  function receive(info) {
      if (info.type === 'edit-result') {
        $('editStatus').textContent = info.ok ? 'Correzione applicata sul tablet.' : 'Correzione non accettata. Riapri l’editor e riprova.';
        return;
      }
      if (info.type !== 'state') return;
      connected = true;
      $('connection').textContent = (info.status || 'Collegato al tablet') +
        (mode === 'direct' ? ' · Diretto' : ' · Via server');
      if (info.content && info.content.revision !== revision) {
        revision = info.content.revision;
        editable = info.content.editable;
        if (editable && !editable.markup && editable.text === undefined) {
          editable = {...editable, text:info.content.text};
        }
        $('remoteEditor').hidden = display || !editable;
        pending = undefined;
        pointer = null;
        if (info.content.markup) copyMarkup(copy, info.content.text);
        else copy.textContent = info.content.text;
        copy.style.whiteSpace = info.content.markup ? 'normal' : 'pre-wrap';
        if (/^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/.test(info.content.image || '')) {
          canvas.src = info.content.image;
        } else canvas.removeAttribute('src');
      }
      if (info.state?.revision === revision && info.state) {
        state = info.state;
        $('waiting').hidden = state.open;
        monitor.hidden = !state.open;
        showCountdown($('remoteCountdown'), state.countdown);
        showReadingTimer($('remoteReadingTimer'), state.timer, display && state.mirrorX, display && state.mirrorY);
        if (display) {
          $('viewerFont').textContent = state.font;
          $('viewerSpeed').textContent = state.speed + ' px/s';
          $('viewerMirrorX').checked = state.mirrorX;
          $('viewerMirrorY').checked = state.mirrorY;
          $('viewerTimer').checked = state.timer != null;
        }
        layout();
        if (!pointer && (state.seekId === pending?.id || performance.now() > pending?.until)) pending = undefined;
        if (!pending) {
          copy.style.transition = state.playing && !pointer ? 'transform 100ms linear' : 'none';
          position(state.offset);
        }
      }
    for (const b of $('remoteControls').children) b.disabled = !connected || !state?.open;
  }
  let mode;
  const send = connectPair(auth, receive, next => {
    mode = next;
    if (mode === 'offline') {
      connected = false;
      commands = [];
      seek = pending = undefined;
      pointer = null;
      $('waiting').hidden = true;
      $('connection').textContent = 'Tablet non raggiungibile. Riconnessione…';
    }
    if (display) {
      $('connection').textContent = next === 'offline' ? 'In attesa del dispositivo di controllo…' : 'Schermo collegato';
      if (next !== 'offline') sendSize();
    }
    for (const b of $('remoteControls').children) b.disabled = !connected || !state?.open;
  }, error => {
    if (display) {
      clearInterval(controlInterval);
      taps.cancel();
      if (viewerSettings.open) viewerSettings.close();
      observer.disconnect();
      removeEventListener('resize', sendSize);
    }
    if (expired) expired(error);
    else $('connection').textContent = 'Sessione scaduta. Abbina di nuovo il telefono.';
  }, ready);
  function sendSize() {
    send({type:'control', displaySize:{width:innerWidth, height:innerHeight}});
  }
  if (display) {
    monitor.hidden = true;
    $('waiting').hidden = true;
    $('waiting').textContent = 'In attesa che il dispositivo di controllo apra l’anteprima.';
    $('remoteEditor').hidden = true;
    $('connection').textContent = 'Collegamento in corso…';
    async function keepDisplayAwake() {
      if (!document.hidden && !$('remote').hidden) {
        try { await navigator.wakeLock?.request('screen'); } catch {}
      }
    }
    keepDisplayAwake();
    document.addEventListener('visibilitychange', keepDisplayAwake);
    addEventListener('resize', sendSize);
    attachMoman([$('momanView')], [$('momanViewStatus')], (axis, incoming) => {
      momanRate = axis;
      momanSeen = performance.now();
      if (connected && state?.open && !viewerSettings.open) commands.push(...incoming.slice(0, Math.max(0, 8 - commands.length)));
    });
    for (const button of viewerSettings.querySelectorAll('[data-gobbo-command]')) {
      button.onclick = () => { if (connected && commands.length < 8) commands.push(button.dataset.gobboCommand); };
    }
    for (const [key, id] of Object.entries({mirrorX:'viewerMirrorX', mirrorY:'viewerMirrorY', timer:'viewerTimer'})) {
      $(id).onchange = () => { if (connected) send({type:'control', settings:{[key]:$(id).checked}}); };
    }
  }
  controlInterval = setInterval(() => {
    if (!connected) return;
    const outgoing = seek || (pointer && pending?.held ? pending : undefined);
    const now = performance.now();
    const rate = state?.open && !document.querySelector('dialog[open]') ?
      (now - gamepadSeen < 120 ? gamepadRate : now - momanSeen < 300 ? momanRate : 0) : 0;
    const jog = (rate || rate !== sentMomanRate) ? rate : undefined;
    if (!outgoing && !edit && !commands.length && jog === undefined) return;
    if (send({type:'control', command:commands[0], seek:outgoing, edit, jog})) {
      sentMomanRate = rate;
      seek = edit = undefined;
      commands.shift();
    }
  }, 80);
}

function openLocalArchive() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('igor-local', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('works', {keyPath:'id'});
      request.result.createObjectStore('media');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Archivio locale bloccato'));
  });
}

function archiveTransaction(db, stores, mode, run) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const result = run(tx);
    tx.oncomplete = () => resolve(result?.result);
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}

function setup() {
  let source = {text:'', html:''};
  let pdf = null;
  let pdfBlob = null;
  let originalFile = null;
  let notes = [];
  let page = 1;
  let renderVersion = 0;
  let font = 58;
  let speed = 52;
  let offset = 0;
  let playing = false;
  let readingStartedAt = 0;
  let readingElapsed = 0;
  const timerToggle = $('showReadingTimer');
  function elapsedSeconds(now = performance.now()) {
    return Math.floor((readingElapsed + (playing ? now - readingStartedAt : 0)) / 1000);
  }
  function setPlaying(next, now = performance.now()) {
    if (playing === next) return;
    if (next) readingStartedAt = now;
    else readingElapsed += now - readingStartedAt;
    playing = next;
  }
  function resetReadingTimer() {
    readingElapsed = 0;
    readingStartedAt = performance.now();
  }
  $('resetReadingTimer').onclick = resetReadingTimer;
  let lastFrame = 0;
  let session = null;
  let wake = null;
  let remotelyStarted = false;
  let send;
  let offlineSince = 0;
  let lastState;
  const copy = $('copy');
  const viewport = $('viewport');
  const stage = $('stage');
  const slide = $('slide');
  let content = {revision:0, text:'', markup:false};
  let sentRevision = -1;
  let appliedSeekId;
  let max = 0;
  let countdownUntil = 0;
  let needsCountdown = true;
  let remoteHoldUntil = 0;
  let momanRate = 0;
  let momanUntil = 0;
  let localDrag;
  let imports = 0;
  let displaySize;
  let soloMode = false;
  let lastSoloMode = false;
  const soloButton = $('soloLaunch');
  const soloSettings = $('viewerSettings');
  const soloTaps = readingTap(
    () => { if (soloMode && !$('screen').hidden && !soloSettings.open) act(playing || countdownUntil ? 'pause' : 'play'); },
    () => {
      if (soloSettings.open) return;
      syncSoloSettings();
      soloSettings.showModal();
    }
  );
  function syncSoloSettings() {
    $('viewerFont').textContent = font;
    $('viewerSpeed').textContent = speed + ' px/s';
    $('viewerMirrorX').checked = $('mirrorX').checked;
    $('viewerMirrorY').checked = $('mirrorY').checked;
    $('viewerTimer').checked = timerToggle.checked;
  }
  for (const button of soloSettings.querySelectorAll('[data-gobbo-command]')) {
    button.onclick = () => { act(button.dataset.gobboCommand); syncSoloSettings(); };
  }
  for (const [id, target] of Object.entries({viewerMirrorX:'mirrorX', viewerMirrorY:'mirrorY', viewerTimer:'showReadingTimer'})) {
    $(id).onchange = () => { $(target).checked = $(id).checked; fitPreview(); };
  }
  $('soloReturn').onclick = () => {
    soloSettings.close();
    $('exit').click();
  };
  let previewScale = 1;
  const previewArea = $('previewArea');
  const view = () => $('view').value;
  const say = message => { $('message').textContent = message; };
  const scroll = delta => {
    const next = Math.max(0, Math.min(max, offset + delta));
    if (delta < 0 && offset > 0 && next === 0) needsCountdown = true;
    offset = next;
    copy.style.transform = 'translateY(' + (-offset) + 'px)';
    return offset === max;
  };
  function measure() {
    if (!viewport.clientHeight) return;
    const middle = viewport.clientHeight / 2;
    copy.style.paddingBlock = middle + 'px';
    max = Math.max(0, copy.offsetHeight - viewport.clientHeight);
    scroll(0);
  }
  new ResizeObserver(measure).observe(viewport);
  function format() {
    const ratio = font / (parseFloat(copy.style.fontSize) || font);
    copy.style.fontSize = font + 'px';
    offset *= ratio;
    measure();
  }
  function fitPreview() {
    const w = (!soloMode && displaySize?.width) || previewArea.clientWidth;
    const h = (!soloMode && displaySize?.height) || previewArea.clientHeight;
    if (!w || !h || !previewArea.clientWidth || !previewArea.clientHeight) return;
    previewScale = Math.min(previewArea.clientWidth / w, previewArea.clientHeight / h);
    Object.assign(stage.style, {
      width:w + 'px', height:h + 'px',
      left:(previewArea.clientWidth - w * previewScale) / 2 + 'px',
      top:(previewArea.clientHeight - h * previewScale) / 2 + 'px',
      transform:'scale(' + previewScale + ')',
      transformOrigin:'top left'
    });
    if (!session || soloMode) {
      stage.style.transformOrigin = 'center';
      stage.style.transform += ' scale(' + ($('mirrorX').checked ? -1 : 1) + ',' + ($('mirrorY').checked ? -1 : 1) + ')';
    }
    copy.style.paddingInline = w * .07 + 'px';
    measure();
  }
  new ResizeObserver(fitPreview).observe(previewArea);
  function showText(keepSlideTimer = false) {
    copy.replaceChildren();
    const markup = view() === 'text' && $('styled').checked && Boolean(source.html);
    copy.style.whiteSpace = markup ? 'normal' : 'pre-wrap';
    if (view() === 'notes' || view() === 'both') {
      copy.textContent = notes[page - 1] || '';
    } else if (markup) {
      copyMarkup(copy, source.html);
    } else {
      copy.textContent = source.text;
    }
    const editable = view() === 'slide' ? null : markup ? {text:source.text, markup} : {markup};
    content = {revision:content.revision + 1, markup, editable, text:markup ? copy.innerHTML : copy.textContent};
    appliedSeekId = undefined;
    remoteHoldUntil = 0;
    offset = 0;
    if (!keepSlideTimer) {
      countdownUntil = 0;
      setPlaying(false);
    }
    format();
  }
  async function draw(keepSlideTimer = false) {
    $('stage').dataset.view = view();
    showText(keepSlideTimer);
    const version = ++renderVersion;
    if (!pdf || !['slide','both'].includes(view())) return;
    const item = await pdf.getPage(page);
    const viewport = item.getViewport({scale:Math.min(2, 1920 / item.getViewport({scale:1}).width)});
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await item.render({canvas, canvasContext:canvas.getContext('2d'), viewport}).promise;
    if (version !== renderVersion) return;
    slide.width = canvas.width;
    slide.height = canvas.height;
    slide.getContext('2d').drawImage(canvas, 0, 0);
    const preview = document.createElement('canvas');
    const scale = Math.min(1, 1440 / Math.max(canvas.width, canvas.height));
    preview.width = Math.max(1, Math.round(canvas.width * scale));
    preview.height = Math.max(1, Math.round(canvas.height * scale));
    preview.getContext('2d').drawImage(canvas, 0, 0, preview.width, preview.height);
    content = {...content, revision:content.revision + 1, image:preview.toDataURL('image/jpeg', .82)};
  }
  const refresh = (keepSlideTimer = false) => draw(keepSlideTimer === true).catch(() => say('Impossibile visualizzare questa pagina.'));
  function act(key, remote = false) {
    key = resolveMomanCommand(key, view());
    if (key === 'play' && (view() !== 'slide' || timerToggle.checked) && !$('screen').hidden && !playing && !countdownUntil) {
      remotelyStarted = remote;
      if (needsCountdown) countdownUntil = performance.now() + 3000;
      else setPlaying(true);
    }
    if (key === 'pause') { setPlaying(false); countdownUntil = 0; }
    if (key === 'faster') speed = Math.min(400, speed + 10);
    if (key === 'slower') speed = Math.max(2, speed - 10);
    if (key === 'larger') { font = Math.min(160, font + 4); format(); }
    if (key === 'smaller') { font = Math.max(20, font - 4); format(); }
    if (key === 'home') { act('pause'); scroll(-offset); needsCountdown = true; }
    if (key === 'back' || key === 'forward') scroll((key === 'back' ? -1 : 1) * font * 1.3);
    if (['next','prev'].includes(key) && view() === 'text') return act(key === 'next' ? 'forward' : 'back', remote);
    if (['next','prev'].includes(key)) {
      const target = page + (key === 'next' ? 1 : -1);
      const total = view() === 'notes' ? notes.length : pdf?.numPages;
      if (target >= 1 && target <= total) { page = target; refresh(view() === 'slide'); }
    }
  }
  let gamepadRate = 0;
  let gamepadSeen = -Infinity;
  remoteControls.connect(view, (command, axis) => {
    if ($('screen').hidden || document.querySelector('dialog[open]')) return;
    if (axis !== undefined) {
      gamepadRate = axis;
      gamepadSeen = performance.now();
    }
    if (command) act(command === 'toggle' ? (playing || countdownUntil ? 'pause' : 'play') : command);
  });
  controls($('localControls'), key => act(key));
  controls($('previewControls'), key => act(key), ['back','forward','slower','faster','smaller','larger','prev','next','home']);
  document.addEventListener('keydown', event => {
    const command = remoteControls.key(event);
    if ($('screen').hidden || !command || document.querySelector('dialog[open]') || keyBlocked(event)) return;
    event.preventDefault();
    if (command === 'toggle') { if (!event.repeat) act(playing || countdownUntil ? 'pause' : 'play'); return; }
    act(command);
  });
  previewArea.onpointerdown = event => {
    if (!event.isPrimary || event.button !== 0 || localDrag || (!soloMode && !viewport.contains(event.target))) return;
    localDrag = {id:event.pointerId, x:event.clientX, y:event.clientY, offset, downAt:performance.now(), moved:false};
    previewArea.setPointerCapture(event.pointerId);
  };
  previewArea.onpointermove = event => {
    if (localDrag?.id !== event.pointerId) return;
    const dy = localDrag.y - event.clientY;
    if (Math.abs(dy) >= 8 || Math.abs(localDrag.x - event.clientX) >= 8) {
      localDrag.moved = true;
      soloTaps.cancel();
    }
    if ((!soloMode || localDrag.moved) && view() !== 'slide') {
      const direction = soloMode && $('mirrorY').checked ? -1 : 1;
      scroll(localDrag.offset + direction * dy / previewScale - offset);
    }
  };
  previewArea.onpointerup = event => {
    if (localDrag?.id !== event.pointerId) return;
    const drag = localDrag;
    localDrag = undefined;
    if (soloMode && !drag.moved && performance.now() - drag.downAt < 350) soloTaps.tap();
  };
  previewArea.onpointercancel = previewArea.onlostpointercapture = () => { localDrag = undefined; };
  previewArea.ondblclick = event => {
    if (!soloMode && event.pointerType !== 'touch') act(playing || countdownUntil ? 'pause' : 'play');
  };
  $('screenPlay').onclick = () => act(playing || countdownUntil ? 'pause' : 'play');
  previewArea.addEventListener('wheel', e => {e.preventDefault(); scroll(e.deltaY / previewScale);}, {passive:false});
  attachMoman([$('momanSetup'), $('momanView')], [$('momanSetupStatus'), $('momanViewStatus')], (axis, incoming) => {
    momanRate = axis;
    momanUntil = performance.now() + 300;
    if ($('screen').hidden || soloSettings.open) return;
    for (const command of incoming) act(command === 'toggle' ? (playing || countdownUntil ? 'pause' : 'play') : command);
  });
  function frame(time) {
    if (remotelyStarted && offlineSince && time - offlineSince > 4000) act('pause');
    if (countdownUntil && time >= countdownUntil) {
      setPlaying(view() !== 'slide' || timerToggle.checked, countdownUntil);
      needsCountdown = !playing;
      countdownUntil = 0;
    }
    showReadingTimer($('readingTimer'), timerToggle.checked ? elapsedSeconds(time) : null,
      (!session || soloMode) && $('mirrorX').checked, (!session || soloMode) && $('mirrorY').checked);
    showCountdown($('countdown'), countdownUntil ? Math.ceil((countdownUntil - time) / 1000) : 0);
    const playLabel = playing || countdownUntil ? 'Pausa' : 'Avvia';
    if ($('screenPlay').textContent !== playLabel) $('screenPlay').textContent = playLabel;
    if (view() !== 'slide' && !localDrag && time >= remoteHoldUntil && !$('screen').hidden) {
      const step = Math.min(80, time - lastFrame) / 1000;
      const manualRate = time - gamepadSeen < 120 ? gamepadRate : 0;
      const jog = !soloSettings.open && !$('remoteTest').open ?
        (manualRate || (time < momanUntil ? momanRate : 0)) : 0;
      if (jog) scroll(jog * 360 * step);
      else if (playing && scroll(step * speed)) setPlaying(false, time);
    }
    lastFrame = time;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  async function keepAwake() {
    if (!$('screen').hidden && !document.hidden) {
      try { wake = await navigator.wakeLock?.request('screen'); } catch {}
    }
  }
  document.addEventListener('visibilitychange', keepAwake);
  // Copioni e posizione restano nel browser. I file binari si scrivono solo al cambio di materiale.
  let activeWork;
  let mediaDirty = false;
  let lastSnapshot;
  let recentWorks = [];
  let restoring = false;
  let saving = false;
  const recoveryStatus = $('localRecoveryStatus');
  const archive = openLocalArchive().catch(() => {
    recoveryStatus.textContent = 'Il browser non consente il recupero locale.';
    return null;
  });

  function snapshot() {
    const text = $('draft').value;
    if (!text.trim() && !pdfBlob) return null;
    return {
      id:activeWork, name:originalFile?.name || text.trim().split(/\r?\n/, 1)[0].slice(0, 72) || 'Copione',
      text, source, notes, view:view(), page, font, speed, offset:Math.round(offset), max,
      mirrorX:$('mirrorX').checked, mirrorY:$('mirrorY').checked, styled:$('styled').checked,
      showTimer:timerToggle.checked, elapsed:elapsedSeconds(), solo:lastSoloMode, revision:content.revision
    };
  }

  function unchanged(next, previous) {
    return previous && Object.keys(next).every(key => next[key] === previous[key]);
  }

  function renderLocalHistory() {
    $('resumeLocal').hidden = $('localRecent').hidden = recentWorks.length === 0;
    $('resumeLocal').onclick = () => restoreLocal(recentWorks[0]);
    $('localRecentList').dataset.latest = recentWorks[0]?.id || '';
    $('localRecentList').replaceChildren();
    for (const work of recentWorks) {
      const row = document.createElement('li');
      const open = document.createElement('button');
      open.textContent = work.name;
      open.onclick = () => restoreLocal(work);
      const remove = document.createElement('button');
      remove.textContent = 'Elimina';
      remove.setAttribute('aria-label', 'Elimina ' + work.name);
      remove.onclick = async () => {
        if (saving || restoring) return;
        try {
          const db = await archive;
          await removeLocal(db, work.id);
          recentWorks = recentWorks.filter(item => item.id !== work.id);
          if (activeWork === work.id) {
            activeWork = undefined;
            lastSnapshot = snapshot();
            mediaDirty = false;
          }
          renderLocalHistory();
        } catch { recoveryStatus.textContent = 'Impossibile eliminare il lavoro.'; }
      };
      row.append(open, remove);
      $('localRecentList').append(row);
    }
  }

  function removeLocal(db, id) {
    return archiveTransaction(db, ['works','media'], 'readwrite', tx => {
      tx.objectStore('works').delete(id);
      tx.objectStore('media').delete(id);
    });
  }

  async function saveLocal() {
    if (restoring || saving || imports) return;
    const next = snapshot();
    if (!next || unchanged(next, lastSnapshot)) return;
    const identifier = activeWork || (globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2));
    const writeMedia = !activeWork || mediaDirty;
    const media = {pdfBlob, originalFile};
    next.id = identifier;
    saving = true;
    try {
      const db = await archive;
      if (!db) return;
      const record = {...next, updated:Date.now()};
      const ranked = [record, ...recentWorks.filter(item => item.id !== identifier)];
      await archiveTransaction(db, ['works','media'], 'readwrite', tx => {
        tx.objectStore('works').put(record);
        if (writeMedia) tx.objectStore('media').put(media, identifier);
        for (const old of ranked.slice(5)) {
          tx.objectStore('works').delete(old.id);
          tx.objectStore('media').delete(old.id);
        }
      });
      activeWork = identifier;
      lastSnapshot = next;
      mediaDirty = false;
      recentWorks = ranked.slice(0, 5);
      if (!$('setup').hidden && $('localRecentList').dataset.latest !== identifier) renderLocalHistory();
      recoveryStatus.textContent = '';
    } catch { recoveryStatus.textContent = 'Salvataggio locale non riuscito. Controlla lo spazio del browser.'; }
    finally { saving = false; }
  }

  async function restoreLocal(work) {
    if (!work || imports || restoring || saving) return;
    restoring = true;
    try {
      const db = await archive;
      const media = await archiveTransaction(db, ['media'], 'readonly', tx => tx.objectStore('media').get(work.id));
      const recoveredPdf = media?.pdfBlob ? await openPdf(await media.pdfBlob.arrayBuffer()) : null;
      pdf = recoveredPdf;
      pdfBlob = media?.pdfBlob || null;
      originalFile = media?.originalFile || null;
      source = work.source;
      notes = work.notes;
      $('draft').value = work.text;
      if (work.view === 'text' && work.text !== source.text) source = {text:work.text, html:''};
      $('view').value = work.view;
      page = Math.min(work.page, pdf?.numPages || notes.length || 1);
      font = work.font;
      speed = work.speed;
      $('mirrorX').checked = work.mirrorX;
      $('mirrorY').checked = work.mirrorY;
      $('styled').checked = work.styled;
      timerToggle.checked = work.showTimer;
      setPlaying(false);
      readingElapsed = work.elapsed * 1000;
      await draw();
      activeWork = work.id;
      mediaDirty = false;
      launch(work.solo);
      scroll(work.max > 0 ? max * work.offset / work.max : work.offset);
      lastSnapshot = undefined;
    } catch { recoveryStatus.textContent = 'Impossibile riprendere questo lavoro locale.'; }
    finally { restoring = false; }
  }

  async function loadLocalHistory() {
    const db = await archive;
    if (!db) return;
    try {
      recentWorks = (await archiveTransaction(db, ['works'], 'readonly', tx => tx.objectStore('works').getAll()))
        .sort((a,b) => b.updated - a.updated).slice(0,5);
      renderLocalHistory();
    } catch { recoveryStatus.textContent = 'Impossibile leggere lo storico locale.'; }
  }

  function newLocalWork(file) {
    needsCountdown = true;
    activeWork = undefined;
    originalFile = file;
    mediaDirty = true;
    lastSnapshot = undefined;
  }

  function launch(solo) {
    if (view() === 'text' && $('draft').value !== source.text) loadDraft();
    if (['slide','both'].includes(view()) && !pdf) return say('Carica prima il PDF delle slide.');
    if (view() === 'notes' && !notes.length) return say('Carica prima il PowerPoint con le note.');
    soloMode = lastSoloMode = solo;
    $('screen').classList.toggle('solo-mode', solo);
    $('soloReturn').hidden = !solo;
    $('setup').hidden = true;
    $('screen').hidden = false;
    if (solo) document.documentElement.requestFullscreen?.().catch(() => {});
    else $('screenPlay').focus({preventScroll:true});
    keepAwake();
    fitPreview();
    if (!restoring) saveLocal();
  }
  $('launch').onclick = () => launch(false);
  soloButton.onclick = () => launch(true);
  $('exit').onclick = () => {
    act('pause');
    localDrag = undefined;
    remoteHoldUntil = 0;
    $('screen').hidden = true;
    $('setup').hidden = false;
    (soloMode ? soloButton : $('launch')).focus();
    soloMode = false;
    soloTaps.cancel();
    renderLocalHistory();
    saveLocal();
    wake?.release().catch(() => {});
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };
  $('mirrorX').onchange = $('mirrorY').onchange = fitPreview;
  $('view').onchange = () => { page = 1; refresh(); };
  $('styled').onchange = refresh;
  function loadDraft() {
    needsCountdown = true;
    source = {text:$('draft').value, html:''};
    $('view').value = 'text';
    refresh();
    say('Testo caricato.');
  }
  $('draft').addEventListener('input', () => {
    if (view() === 'text') return;
    $('view').value = 'text';
    $('view').onchange();
  });
  async function openPdf(bytes) {
    const lib = await import('./pdf.mjs');
    lib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', location.href).href;
    return lib.getDocument({data:new Uint8Array(bytes), isEvalSupported:false}).promise;
  }
  async function importDocument(file, isDeck = false) {
    if (!file) return;
    if (restoring) return;
    await saveLocal();
    const ext = file.name.split('.').pop().toLowerCase();
    say('Importazione in corso…');
    imports++;
    $('launch').disabled = soloButton.disabled = true;
    try {
      if (ext === 'docx') {
        const arrayBuffer = await file.arrayBuffer();
        const html = await mammoth.convertToHtml({arrayBuffer}, {ignoreEmptyParagraphs:false});
        const raw = await mammoth.extractRawText({arrayBuffer});
        source = {text:raw.value, html:html.value};
        $('draft').value = raw.value;
        $('view').value = 'text';
      } else if (ext === 'pdf') {
        pdf = await openPdf(await file.arrayBuffer());
        pdfBlob = file;
        notes = [];
        page = 1;
        const paragraphs = [];
        for (let i = 1; !isDeck && i <= pdf.numPages; i++) {
          const pdfPage = await pdf.getPage(i);
          const text = await pdfPage.getTextContent();
          paragraphs.push(text.items.map(part => (part.str || '') + (part.hasEOL ? '\n' : ' ')).join('').trim());
        }
        const text = paragraphs.join('\n\n').trim();
        if (!isDeck) {
          source = {text, html:''};
          $('draft').value = text;
        }
        $('view').value = isDeck || !text ? 'slide' : 'text';
      } else {
        source = {text:await file.text(), html:''};
        $('draft').value = source.text;
        $('view').value = 'text';
      }
      await draw();
      newLocalWork(file);
      say(!isDeck && ext === 'pdf' && !source.text ? 'PDF caricato come slide. Nessun testo selezionabile trovato.' : 'File caricato. Puoi aprire lo schermo.');
    } catch { say('Importazione non riuscita. Verifica il formato del file.'); }
    finally {
      $('launch').disabled = soloButton.disabled = --imports > 0;
      saveLocal();
    }
  }

  async function readPowerPointNotes(file) {
      const zip = await JSZip.loadAsync(file);
      const xml = async name => {
        const entry = zip.file(name);
        return entry ? new DOMParser().parseFromString(await entry.async('string'), 'application/xml') : null;
      };
      const elements = (doc, name) => Array.from(doc?.getElementsByTagNameNS('*',name) || []);
      const resolve = (base, target) => new URL(target, 'https://local.invalid/' + base).pathname.slice(1);
      const rels = name => name.replace(/([^/]+)$/, '_rels/$1.rels');
      const presentation = 'ppt/presentation.xml';
      const deck = await xml(presentation);
      const links = elements(await xml(rels(presentation)), 'Relationship');
      const imported = [];
      for (const item of elements(deck, 'sldId')) {
        const id = Array.from(item.attributes).find(a => a.localName === 'id' && a.namespaceURI)?.value;
        const link = links.find(rel => rel.getAttribute('Id') === id);
        if (!link) { imported.push(''); continue; }
        const slide = resolve(presentation, link.getAttribute('Target'));
        const note = elements(await xml(rels(slide)), 'Relationship').find(rel => rel.getAttribute('Type')?.endsWith('/notesSlide'));
        if (!note) { imported.push(''); continue; }
        const noteDoc = await xml(resolve(slide,note.getAttribute('Target')));
        const shapes = elements(noteDoc,'sp').filter(shape => elements(shape,'ph').some(ph => ph.getAttribute('type') === 'body'));
        imported.push(shapes.flatMap(shape => elements(shape,'p').map(p => elements(p,'t').map(t => t.textContent).join(''))).join('\n'));
      }
      if (!imported.length) throw new Error('Il file PowerPoint non contiene slide leggibili.');
      return imported;
  }

  let converter;
  async function convertLocally(file) {
    if (!converter) {
      const base = new URL('office-2.7.2/', location.href);
      const { WorkerBrowserConverter, createWasmPaths } = await import(new URL('dist/browser.js', base));
      const instance = new WorkerBrowserConverter({
        ...createWasmPaths(new URL('wasm/', base).href),
        browserWorkerJs:new URL('dist/browser.worker.global.js', base).href,
        onProgress:info => say(info.message || 'Preparazione del convertitore…')
      });
      try {
        await instance.initialize();
        converter = instance;
      } catch (error) {
        await instance.destroy?.();
        throw error;
      }
    }
    say('Conversione del PowerPoint sul dispositivo…');
    const result = await converter.convert(new Uint8Array(await file.arrayBuffer()), {outputFormat:'pdf'}, file.name);
    const blob = new Blob([result.data], {type:'application/pdf'});
    const converted = await openPdf(result.data);
    pdfBlob = blob;
    return converted;
  }
  function confirmConverterDownload() {
    const dialog = $('pptxDownload');
    dialog.returnValue = 'cancel';
    return new Promise(resolve => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'download'), {once:true});
      dialog.showModal();
    });
  }
  async function importPowerPoint(input) {
    const file = input.files[0];
    if (!file || restoring) return;
    await saveLocal();
    const fileInputs = ['file','slidesFile'].map($);
    imports++;
    $('launch').disabled = soloButton.disabled = true;
    fileInputs.forEach(element => { element.disabled = true; });
    say('Conversione del PowerPoint in corso…');
    try {
      if (file.size > 40 * 1024 * 1024) throw new Error('Il PowerPoint supera il limite di 40 MB.');
      if ((!window.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined')) {
        throw new Error('La conversione locale richiede un browser compatibile e una pagina HTTPS. Puoi caricare un PDF in Slide.');
      }
      if (!converter && !await confirmConverterDownload()) {
        say('Download annullato. Puoi caricare un PDF in Slide.');
        return;
      }
      const imported = await readPowerPointNotes(file);
      try {
        say('Caricamento del convertitore PowerPoint…');
        pdf = await convertLocally(file);
      } catch {
        throw new Error('Conversione non riuscita su questo dispositivo. Riprova oppure carica un PDF in Slide.');
      }
      const matching = !pdf || pdf.numPages === imported.length;
      notes = matching ? imported : [];
      page = 1;
      $('view').value = 'slide';
      await draw();
      newLocalWork(file);
      if (!matching) say('Il numero di pagine PDF e di slide PowerPoint è diverso. Verifica la corrispondenza prima di usare le note.');
      else say(imported.some(Boolean) ? 'Slide caricate. Seleziona Slide + note per mostrare anche le note del relatore.' : 'Slide caricate. Puoi aprire lo schermo.');
    } catch (error) {
      say(error.name === 'TimeoutError' ? 'Tempo di conversione scaduto. Riprova o carica un PDF in Slide.' :
        error.message || 'Impossibile importare il PowerPoint.');
    } finally {
      input.value = '';
      fileInputs.forEach(element => { element.disabled = false; });
      $('launch').disabled = soloButton.disabled = --imports > 0;
      saveLocal();
    }
  }
  $('file').onchange = event => importDocument(event.currentTarget.files[0]);
  $('slidesFile').onchange = event => {
    const input = event.currentTarget;
    const file = input.files[0];
    if (!file) return;
    if (/\.pptx$/i.test(file.name)) return importPowerPoint(input);
    if (/\.pdf$/i.test(file.name)) return importDocument(file, true);
    say('Scegli una presentazione PDF o PowerPoint (.pptx).');
  };

  $('pair').onclick = async () => {
    $('pair').disabled = true;
    try {
      const next = await api('new');
      send?.close();
      session = next;
      const url = new URL(location.href);
      url.searchParams.set('schermo', '1');
      url.hash = 'viewer=' + session.code;
      $('pairLink').href = url.href;
      $('qr').src = 'api/qr?link=' + encodeURIComponent(url.href);
      $('pairCode').textContent = session.code;
      $('pairing').hidden = false;
      $('pair').textContent = 'Genera nuovo codice';
      say('Il codice è valido per cinque minuti e si usa una sola volta.');
      send = connectPair({...session, role:'screen'}, applyControl, mode => {
        offlineSince = mode === 'offline' ? performance.now() : 0;
        const label = mode === 'offline' ? 'In attesa del tablet' :
          mode === 'direct' ? 'Tablet collegato · Diretto' : 'Tablet collegato · Via server';
        $('pairStatus').textContent = label;
        $('previewStatus').textContent = label;
        lastState = undefined;
        sentRevision = -1;
      }, () => {
        send = undefined;
        $('pair').disabled = false;
        $('pairing').hidden = true;
        $('previewStatus').textContent = 'Sessione scaduta. Genera un nuovo codice.';
        say('Sessione scaduta. Genera un nuovo codice.');
      });
    } catch {
      say('Abbinamento non disponibile. Riprova.');
    } finally {
      $('pair').disabled = false;
    }
  };
  function publishState() {
      if (!send) return;
      const count = view() === 'notes' ? notes.length : pdf?.numPages || 0;
      const countdown = countdownUntil ? Math.max(1, Math.ceil((countdownUntil - performance.now()) / 1000)) : 0;
      const status = (countdown ? 'Avvio tra ' + countdown : playing ? 'In lettura' : 'In pausa') + ' · ' + speed + ' px/s · Font ' + font +
        (view() === 'text' ? '' : ' · Slide ' + page + '/' + count);
      const rect = element => ({x:element.offsetLeft, y:element.offsetTop, w:element.clientWidth, h:element.clientHeight});
      const state = {
        revision:content.revision, view:view(), width:stage.clientWidth, height:stage.clientHeight,
        viewport:rect(viewport), slide:content.image ? rect(slide) : null,
        font, speed, padding:getComputedStyle(copy).padding, offset, max, countdown, open:!soloMode && !$('screen').hidden,
        mirrorX:$('mirrorX').checked, mirrorY:$('mirrorY').checked,
        timer:timerToggle.checked ? elapsedSeconds() : null,
        playing:playing && !localDrag && performance.now() >= remoteHoldUntil, seekId:appliedSeekId
      };
      const snapshot = JSON.stringify({state, status});
      if (snapshot === lastState) return;
      if (send({type:'state', state, status, content:sentRevision === state.revision ? undefined : content})) {
        sentRevision = state.revision;
        lastState = snapshot;
      }
  }
  function applyControl(message) {
    if (soloMode || message.type !== 'control') return;
    if (Number.isFinite(message.jog) && Math.abs(message.jog) <= 1) {
      momanRate = message.jog;
      momanUntil = performance.now() + 300;
    }
    const size = message.displaySize;
    if (size && [size.width, size.height].every(value => Number.isFinite(value) && value >= 160 && value <= 4096)) {
      displaySize = size;
      fitPreview();
      return;
    }
    const item = message.seek;
    if (item && item.revision === content.revision && Number.isFinite(item.offset) &&
        !localDrag && !$('screen').hidden) {
          remoteHoldUntil = item.held ? performance.now() + 750 : 0;
          scroll(item.offset - offset);
          appliedSeekId = String(item.id || '').slice(0, 48);
    }
    const correction = message.edit;
    if (correction) {
      const valid = correction.revision === content.revision && content.editable &&
        typeof correction.text === 'string' && correction.text.length <= 100_000;
      if (valid) {
          const previous = offset;
          if (view() === 'text') {
            source = {text:correction.text, html:''};
            $('draft').value = correction.text;
          } else notes[page - 1] = correction.text;
          const image = content.image;
          showText();
          if (image) content.image = image;
          scroll(previous);
      }
      send?.({type:'edit-result', ok:Boolean(valid)});
    }
    const settings = message.settings;
    if (settings && typeof settings === 'object') {
      if (typeof settings.mirrorX === 'boolean') $('mirrorX').checked = settings.mirrorX;
      if (typeof settings.mirrorY === 'boolean') $('mirrorY').checked = settings.mirrorY;
      if (typeof settings.timer === 'boolean') timerToggle.checked = settings.timer;
      fitPreview();
    }
    if (message.command === 'toggle' && !$('screen').hidden) {
      act(playing || countdownUntil ? 'pause' : 'play', true);
    } else {
      const command = resolveMomanCommand(message.command, view());
      if (Object.hasOwn(buttons, command)) act(command, true);
    }
  }
  setInterval(publishState, 100);
  loadLocalHistory();
  setInterval(saveLocal, 1000);
  addEventListener('pagehide', saveLocal);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveLocal(); });
  format();
}

/* ---- Rifiniture dell'interfaccia: non toccano sincronizzazione e lettura ---- */
(() => {
  const $ = id => document.getElementById(id);

  // File: nome scelto e trascinamento sulle aree di caricamento.
  for (const zone of document.querySelectorAll('.dropzone')) {
    const input = zone.querySelector('input[type=file]');
    const label = zone.querySelector('.dz-file');
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      label.textContent = 'Selezionato: ' + file.name;
      zone.classList.add('has-file');
    });
    for (const type of ['dragenter', 'dragover']) {
      zone.addEventListener(type, event => { event.preventDefault(); zone.classList.add('is-over'); });
    }
    for (const type of ['dragleave', 'drop']) {
      zone.addEventListener(type, event => { event.preventDefault(); zone.classList.remove('is-over'); });
    }
    zone.addEventListener('drop', event => {
      const file = event.dataTransfer?.files?.[0];
      if (!file || input.disabled) return;
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', {bubbles:true}));
    });
  }
  // Un file lasciato fuori dalle aree non deve far aprire il documento nel browser.
  for (const type of ['dragover', 'drop']) {
    addEventListener(type, event => { if (event.dataTransfer?.types?.includes('Files')) event.preventDefault(); });
  }

  // Conteggio parole e durata stimata del copione (circa 140 parole al minuto).
  const draft = $('draft');
  const stats = $('draftStats');
  let shown;
  function updateStats() {
    if (draft.value === shown) return;
    shown = draft.value;
    const words = shown.trim() ? shown.trim().split(/\s+/).length : 0;
    if (!words) { stats.textContent = ''; return; }
    const minutes = words / 140;
    stats.textContent = words.toLocaleString('it-IT') + (words === 1 ? ' parola' : ' parole') + ' · circa ' +
      (minutes < 1 ? 'meno di 1 minuto' : Math.round(minutes) + (Math.round(minutes) === 1 ? ' minuto' : ' minuti')) +
      ' a voce';
  }
  draft.addEventListener('input', updateStats);
  setInterval(updateStats, 600); // il testo importato da file non genera eventi input
  updateStats();

  // Comandi della vista di controllo: blocchi con etichetta (solo qui; il pannello operatore resta piatto).
  const bar = $('previewControls');
  for (const [name, keys] of [['Scorri', ['back','forward','home']], ['Velocità', ['slower','faster']],
      ['Testo', ['smaller','larger']], ['Slide', ['prev','next']]]) {
    const items = keys.map(key => bar.querySelector('[data-key=' + key + ']')).filter(Boolean);
    if (!items.length) continue;
    const group = document.createElement('div');
    group.className = 'ctl-group';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', name);
    const caption = document.createElement('span');
    caption.className = 'ctl-cap';
    caption.textContent = name;
    const buttonsRow = document.createElement('div');
    buttonsRow.className = 'ctl-btns';
    buttonsRow.append(...items);
    group.append(caption, buttonsRow);
    bar.append(group);
  }
  // Con il solo testo le slide non servono: il blocco compare con slide o note.
  const slideGroup = bar.querySelector('[aria-label=Slide]');
  const syncSlideGroup = () => { if (slideGroup) slideGroup.hidden = $('view').value === 'text'; };
  $('view').addEventListener('change', syncSlideGroup);
  new MutationObserver(syncSlideGroup).observe($('screen'), {attributes:true, attributeFilter:['hidden']});
  syncSlideGroup();

  // Il focus non deve restare su un pulsante: pedale e clicker devono funzionare subito dopo l'avvio
  // e dopo ogni clic, senza attivare per sbaglio il pulsante che ha il focus.
  for (const root of [$('screen'), $('remote')]) {
    root.addEventListener('click', event => {
      const element = event.target.closest('button, input[type=checkbox]');
      if (element && event.detail) element.blur();
    });
    new MutationObserver(() => { if (!root.hidden) document.activeElement?.blur?.(); })
      .observe(root, {attributes:true, attributeFilter:['hidden']});
  }

  // Stato di collegamento: punto colorato accanto alle etichette di stato.
  function stateOf(text) {
    if (/scadut|non disponibile|impossibile|troppi/i.test(text)) return 'bad';
    if (/in attesa|in corso|riconness/i.test(text)) return 'wait';
    if (/collegat|diretto|via server/i.test(text)) return 'ok';
    return '';
  }
  for (const id of ['pairStatus', 'previewStatus', 'connection']) {
    const element = $(id);
    const sync = () => {
      const state = stateOf(element.textContent);
      if (state) element.dataset.state = state; else delete element.dataset.state;
    };
    new MutationObserver(sync).observe(element, {childList:true, characterData:true, subtree:true});
    sync();
  }

  // Pulsante principale: icona e aspetto seguono lo stato avvia/pausa.
  const play = $('screenPlay');
  const syncPlay = () => { play.dataset.playing = String(play.textContent.trim() === 'Pausa'); };
  new MutationObserver(syncPlay).observe(play, {childList:true, characterData:true, subtree:true});
  syncPlay();

  // Messaggi di errore o avanzamento: porta in vista quelli fuori schermo.
  const message = $('message');
  new MutationObserver(() => {
    if (!message.textContent || $('setup').hidden) return;
    const box = message.getBoundingClientRect();
    if (box.top < 0 || box.bottom > innerHeight) {
      message.scrollIntoView({block:'nearest', behavior:matchMedia('(prefers-reduced-motion:reduce)').matches ? 'auto' : 'smooth'});
    }
  }).observe(message, {childList:true, characterData:true, subtree:true});

  // Schermo del tablet: codice sempre maiuscolo, senza caratteri non validi, tastiera subito pronta.
  const code = $('screenCode');
  code.addEventListener('input', () => {
    const clean = code.value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 5);
    if (clean !== code.value) code.value = clean;
  });
  const join = $('joinScreen');
  const focusCode = () => { if (!join.hidden) code.focus({preventScroll:true}); };
  new MutationObserver(focusCode).observe(join, {attributes:true, attributeFilter:['hidden']});
  focusCode();
})();


function setupRemoteControls() {
  const dialog = $('remoteTest');
  const mode = $('remoteMapMode');
  const action = $('remoteMapAction');
  const last = $('remoteTestLast');
  const log = $('remoteTestLog');
  const storageKey = 'igor-remote-mappings-v1';
  let mappings = {text:{}, slide:{}};
  let learning = false;
  let frameId = 0;
  const held = new Map();
  const padKeys = {0:' ', 3:'Home', 4:'PageUp', 5:'PageDown', 6:'-', 7:'+', 12:'ArrowUp', 13:'ArrowDown', 14:'ArrowLeft', 15:'ArrowRight'};
  const repeatButtons = [6, 7, 12, 13];
  let receive = () => {};
  let currentMode = () => 'text';
  const profile = () => currentMode() === 'text' ? 'text' : 'slide';
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    for (const name of ['text', 'slide']) {
      for (const [input, command] of Object.entries(saved?.[name] || {})) {
        if (Object.hasOwn(commandLabels, command)) mappings[name][input] = command;
      }
    }
  } catch {}

  for (const [command, label] of Object.entries(commandLabels)) {
    action.add(new Option(label, command));
  }

  function save(message) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(mappings));
      last.textContent = message;
    } catch {
      last.textContent = message + ' La modifica vale fino alla chiusura della pagina.';
    }
  }

  function inspect(input, label, fallback) {
    if (learning) {
      const map = mappings[mode.value];
      for (const key of Object.keys(map)) {
        if (map[key] === action.value) delete map[key];
      }
      map[input] = action.value;
      learning = false;
      save(label + ' → ' + commandLabels[action.value]);
    } else {
      const assigned = mappings[mode.value][input] || fallback;
      last.textContent = label + ' → ' + (commandLabels[assigned] || 'non assegnato');
    }
    const item = document.createElement('li');
    item.textContent = last.textContent;
    log.prepend(item);
    while (log.children.length > 6) log.lastElementChild.remove();
  }

  function defaultKey(key) {
    return Object.hasOwn(keyCommands, key) ? keyCommands[key] : undefined;
  }

  function keyboardInput(event) {
    return 'key:' + event.key;
  }

  for (const button of document.querySelectorAll('[data-remote-config]')) {
    button.onclick = () => {
      mode.value = profile();
      last.textContent = 'In attesa di un input.';
      log.replaceChildren();
      learning = false;
      dialog.showModal();
      dialog.focus();
      startPolling();
    };
  }
  $('remoteMapLearn').onclick = () => {
    learning = true;
    last.textContent = 'Premi un tasto o muovi uno stick.';
    dialog.focus();
  };
  $('remoteMapReset').onclick = () => {
    mappings[mode.value] = {};
    learning = false;
    log.replaceChildren();
    save('Mappatura predefinita ripristinata.');
  };
  mode.onchange = action.onchange = () => { learning = false; last.textContent = 'In attesa di un input.'; };
  dialog.onclose = () => { learning = false; };
  addEventListener('keydown', event => {
    if (!dialog.open || event.key === 'Escape' || event.key === 'Tab' ||
        event.ctrlKey || event.metaKey || event.altKey ||
        ['Shift', 'Control', 'Alt', 'Meta', 'Dead', 'Unidentified'].includes(event.key)) return;
    if (event.target.closest('select, button')) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) inspect(keyboardInput(event), 'Tasto ' + (event.key === ' ' ? 'Spazio' : event.key), defaultKey(event.key));
  }, true);

  function poll(time) {
    frameId = 0;
    const pads = Array.from(navigator.getGamepads?.() || []).filter(Boolean);
    const active = new Set();
    const map = mappings[profile()];
    for (const pad of pads) {
      function input(key, name, fallback, repeat = false, sample = 0, analog = false) {
        const id = pad.index + ':' + key;
        active.add(id);
        const command = map[key] || fallback;
        const deadline = held.get(id);
        if (deadline === undefined) {
          held.set(id, time + 350);
          if (dialog.open) inspect(key, name, fallback);
          else if (command && !(analog && ['back', 'forward'].includes(command))) receive(command);
        } else if (repeat && time >= deadline) {
          held.set(id, time + 120);
          if (!dialog.open && command && command !== 'toggle') receive(command);
        }
        if (!dialog.open && analog && ['back', 'forward'].includes(command)) {
          receive(null, sample * (command === 'back' ? -1 : 1));
        }
      }
      pad.buttons.forEach((button, index) => {
        if (button.pressed) input('button:' + index, 'Gamepad · pulsante ' + (index + 1), keyCommands[padKeys[index]], repeatButtons.includes(index));
      });
      pad.axes.forEach((value, index) => {
        const direction = value < 0 ? '-' : '+';
        const key = 'axis:' + index + direction;
        const magnitude = Math.abs(value);
        // Richiedi un movimento netto per imparare un asse, poi usa una zona morta più piccola.
        const threshold = dialog.open ? .65 : .22;
        if (magnitude > threshold) input(key, 'Gamepad · asse ' + (index + 1) + ' ' + direction,
          undefined, false, (magnitude - threshold) / (1 - threshold), true);
      });
    }
    for (const id of held.keys()) if (!active.has(id)) held.delete(id);
    if (dialog.open || pads.length) startPolling();
  }
  function startPolling() {
    if (!frameId && navigator.getGamepads) frameId = requestAnimationFrame(poll);
  }
  addEventListener('gamepadconnected', startPolling);
  startPolling();

  return {
    key(event) {
      if (dialog.open) return undefined;
      return mappings[profile()][keyboardInput(event)] || defaultKey(event.key);
    },
    connect(modeOf, onInput) {
      currentMode = modeOf;
      receive = onInput;
    }
  };
}

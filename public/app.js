const $ = id => document.getElementById(id);
const buttons = {
  play:'Avvia', pause:'Pausa', slower:'− Velocità', faster:'+ Velocità',
  back:'↑ Indietro', forward:'↓ Avanti', home:'Torna all’inizio',
  prev:'‹ Slide', next:'Slide ›', smaller:'− Font', larger:'+ Font'
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
    button.onclick = () => action(key);
    container.append(button);
  }
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
    if (display || !connected || !state?.viewport.w || state.revision !== revision) return;
    const target = Math.min(state.max, Math.max(0, value));
    copy.style.transition = 'none';
    position(target);
    seek = {offset:target, revision, id:seekId(), held};
    pending = {...seek, until:performance.now() + 4000};
  }
  monitor.onpointerdown = event => {
    if (!connected || !state?.viewport.w || pointer || !event.isPrimary || event.button !== 0) return;
    pointer = {id:event.pointerId, start:event.clientY, offset};
    monitor.setPointerCapture(event.pointerId);
    dragTo(offset, true);
  };
  monitor.onpointermove = event => {
    if (pointer?.id === event.pointerId && scale > 0) {
      dragTo(pointer.offset + (pointer.start - event.clientY) / scale, true);
    }
  };
  monitor.onlostpointercapture = () => {
    if (!pointer) return;
    pointer = null;
    dragTo(offset);
  };
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
    $('viewerActions').hidden = false;
    monitor.hidden = true;
    $('waiting').hidden = true;
    $('waiting').textContent = 'In attesa che il dispositivo di controllo apra l’anteprima.';
    $('remoteEditor').hidden = true;
    $('connection').textContent = 'Collegamento in corso…';
    $('viewerFull').hidden = !document.fullscreenEnabled;
    $('viewerFull').onclick = () => document.documentElement.requestFullscreen?.().catch(() => {});
    async function keepDisplayAwake() {
      if (!document.hidden && !$('remote').hidden) {
        try { await navigator.wakeLock?.request('screen'); } catch {}
      }
    }
    keepDisplayAwake();
    document.addEventListener('visibilitychange', keepDisplayAwake);
    addEventListener('resize', sendSize);
    return;
  }
  setInterval(() => {
    if (!connected) return;
    const outgoing = seek || (pointer && pending?.held ? pending : undefined);
    if (!outgoing && !edit && !commands.length) return;
    if (send({type:'control', command:commands[0], seek:outgoing, edit})) {
      seek = edit = undefined;
      commands.shift();
    }
  }, 80);
}

function setup() {
  let source = {text:'', html:''};
  let pdf = null;
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
  let remoteHoldUntil = 0;
  let localDrag;
  let imports = 0;
  let displaySize;
  let previewScale = 1;
  const previewArea = $('previewArea');
  const view = () => $('view').value;
  const say = message => { $('message').textContent = message; };
  const scroll = delta => {
    offset = Math.max(0, Math.min(max, offset + delta));
    copy.style.transform = 'translateY(' + (-offset) + 'px)';
    return offset === max;
  };
  function measure() {
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
    const w = displaySize?.width || previewArea.clientWidth;
    const h = displaySize?.height || previewArea.clientHeight;
    if (!w || !h || !previewArea.clientWidth || !previewArea.clientHeight) return;
    previewScale = Math.min(previewArea.clientWidth / w, previewArea.clientHeight / h);
    Object.assign(stage.style, {
      width:w + 'px', height:h + 'px',
      left:(previewArea.clientWidth - w * previewScale) / 2 + 'px',
      top:(previewArea.clientHeight - h * previewScale) / 2 + 'px',
      transform:'scale(' + previewScale + ')',
      transformOrigin:'top left'
    });
    if (!session) {
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
    if (key === 'play' && (view() !== 'slide' || timerToggle.checked) && !$('screen').hidden && !playing && !countdownUntil) {
      countdownUntil = performance.now() + 3000;
      remotelyStarted = remote;
    }
    if (key === 'pause') { setPlaying(false); countdownUntil = 0; }
    if (key === 'faster') speed = Math.min(400, speed + 10);
    if (key === 'slower') speed = Math.max(2, speed - 10);
    if (key === 'larger') { font = Math.min(160, font + 4); format(); }
    if (key === 'smaller') { font = Math.max(20, font - 4); format(); }
    if (key === 'home') { act('pause'); scroll(-offset); }
    if (key === 'back' || key === 'forward') scroll((key === 'back' ? -1 : 1) * font * 1.3);
    if (['next','prev'].includes(key) && view() !== 'text') {
      const target = page + (key === 'next' ? 1 : -1);
      const total = view() === 'notes' ? notes.length : pdf?.numPages;
      if (target >= 1 && target <= total) { page = target; refresh(view() === 'slide'); }
    }
  }
  controls($('localControls'), key => act(key));
  controls($('previewControls'), key => act(key), ['back','forward','slower','faster','smaller','larger','prev','next','home']);
  const keys = {' ':'toggle', ArrowUp:'back', ArrowDown:'forward', ArrowRight:'next',
    ArrowLeft:'prev', PageUp:'prev', PageDown:'next', '+':'faster', '-':'slower', Home:'home'};
  document.addEventListener('keydown', event => {
    if ($('screen').hidden || !Object.hasOwn(keys,event.key) ||
        event.target.closest?.('input, textarea, select, button, a, [contenteditable]')) return;
    event.preventDefault();
    act(event.key === ' ' ? (playing || countdownUntil ? 'pause' : 'play') : keys[event.key]);
  });
  viewport.onpointerdown = event => {
    if (!event.isPrimary || event.button !== 0 || localDrag) return;
    localDrag = {id:event.pointerId, y:event.clientY, offset};
    viewport.setPointerCapture(event.pointerId);
  };
  viewport.onpointermove = event => {
    if (localDrag?.id !== event.pointerId) return;
    const delta = (localDrag.y - event.clientY) / previewScale;
    scroll(localDrag.offset + delta - offset);
  };
  viewport.onlostpointercapture = () => { localDrag = undefined; };
  previewArea.ondblclick = event => {
    if (event.pointerType !== 'touch') act(playing || countdownUntil ? 'pause' : 'play');
  };
  $('screenPlay').onclick = () => act(playing || countdownUntil ? 'pause' : 'play');
  previewArea.addEventListener('wheel', e => {e.preventDefault(); scroll(e.deltaY / previewScale);}, {passive:false});
  function frame(time) {
    if (remotelyStarted && offlineSince && time - offlineSince > 4000) act('pause');
    if (countdownUntil && time >= countdownUntil) {
      setPlaying(view() !== 'slide' || timerToggle.checked, countdownUntil);
      countdownUntil = 0;
    }
    showReadingTimer($('readingTimer'), timerToggle.checked ? elapsedSeconds(time) : null,
      !session && $('mirrorX').checked, !session && $('mirrorY').checked);
    showCountdown($('countdown'), countdownUntil ? Math.ceil((countdownUntil - time) / 1000) : 0);
    const playLabel = playing || countdownUntil ? 'Pausa' : 'Avvia';
    if ($('screenPlay').textContent !== playLabel) $('screenPlay').textContent = playLabel;
    if (playing && view() !== 'slide' && !localDrag && time >= remoteHoldUntil && !$('screen').hidden &&
        scroll(Math.min(80, time - lastFrame) * speed / 1000)) setPlaying(false, time);
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
  $('launch').onclick = () => {
    if (view() === 'text' && $('draft').value !== source.text) loadDraft();
    if (['slide','both'].includes(view()) && !pdf) return say('Carica prima il PDF delle slide.');
    if (view() === 'notes' && !notes.length) return say('Carica prima il PowerPoint con le note.');
    $('setup').hidden = true;
    $('screen').hidden = false;
    $('screenPlay').focus({preventScroll:true});
    keepAwake();
    fitPreview();
  };
  $('exit').onclick = () => {
    act('pause');
    localDrag = undefined;
    remoteHoldUntil = 0;
    $('screen').hidden = true;
    $('setup').hidden = false;
    $('launch').focus();
    wake?.release().catch(() => {});
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };
  $('mirrorX').onchange = $('mirrorY').onchange = fitPreview;
  $('view').onchange = () => { page = 1; refresh(); };
  $('styled').onchange = refresh;
  function loadDraft() {
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
    const ext = file.name.split('.').pop().toLowerCase();
    say('Importazione in corso…');
    imports++;
    $('launch').disabled = true;
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
      say(!isDeck && ext === 'pdf' && !source.text ? 'PDF caricato come slide. Nessun testo selezionabile trovato.' : 'File caricato. Puoi aprire lo schermo.');
    } catch { say('Importazione non riuscita. Verifica il formato del file.'); }
    finally { $('launch').disabled = --imports > 0; }
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
    return openPdf(result.data);
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
    if (!file) return;
    const fileInputs = ['file','slidesFile'].map($);
    imports++;
    $('launch').disabled = true;
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
      if (!matching) say('Il numero di pagine PDF e di slide PowerPoint è diverso. Verifica la corrispondenza prima di usare le note.');
      else say(imported.some(Boolean) ? 'Slide caricate. Seleziona Slide + note per mostrare anche le note del relatore.' : 'Slide caricate. Puoi aprire lo schermo.');
    } catch (error) {
      say(error.name === 'TimeoutError' ? 'Tempo di conversione scaduto. Riprova o carica un PDF in Slide.' :
        error.message || 'Impossibile importare il PowerPoint.');
    } finally {
      input.value = '';
      fileInputs.forEach(element => { element.disabled = false; });
      $('launch').disabled = --imports > 0;
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
        font, padding:getComputedStyle(copy).padding, offset, max, countdown, open:!$('screen').hidden,
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
    if (message.type !== 'control') return;
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
    if (Object.hasOwn(buttons, message.command)) act(message.command,true);
  }
  setInterval(publishState, 100);
  format();
}


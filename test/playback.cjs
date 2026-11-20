const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {runInNewContext} = require('node:vm');

// Drive the real playback loop with a deterministic clock and minimal DOM.
const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
const setup = source.slice(source.indexOf('function setup() {'), source.indexOf('/* ---- Rifiniture'));
const indicators = source.slice(source.indexOf('function showReadingTimer'), source.indexOf('function copyMarkup'));
const revealGesture = source.slice(source.indexOf('function revealMomanOnClicks'), source.indexOf('const remoteControls ='));
const elements = new Map();
const frames = [];
const listeners = new Map();
let now = 0;
let gamepad;
let moman;
let click;
const noop = () => {};
function $(id) {
  if (!elements.has(id)) elements.set(id, {
    style:{}, classList:{toggle:noop}, querySelectorAll:() => [], focus:noop,
    addEventListener:noop, setPointerCapture:noop, clientHeight:500, offsetHeight:2000,
    showModal() { this.open = true; },
    replaceChildren(child) { this.textContent = String(child.textContent); },
    value:id === 'view' ? 'text' : '', hidden:['screen', 'momanControls'].includes(id)
  });
  return elements.get(id);
}
runInNewContext(indicators + revealGesture + setup + "\nsetup(); revealMomanOnClicks({addEventListener: (_, listener) => installClick(listener)}, $('momanControls'));", {
  $, installClick:listener => { click = listener; }, document:{
    addEventListener:(type, listener) => listeners.set(type, listener),
    querySelector:() => null, createElement:() => ({})
  },
  performance:{now:() => now}, navigator:{bluetooth:{}}, isSecureContext:true,
  ResizeObserver:class { observe() {} },
  requestAnimationFrame:frame => frames.push(frame), setInterval:noop, addEventListener:noop,
  keyBlocked:() => false, readingTap:() => ({}), controls:noop, resolveMomanCommand:command => command,
  remoteControls:{connect:(_, listener) => { gamepad = listener; }, key:event => event.command},
  attachMoman:(_, __, listener) => { moman = listener; }, openLocalArchive:async () => null
});
function tick(time) {
  now = time;
  assert.equal(frames.length, 1);
  frames.shift()(time);
}
$('screen').hidden = false;
$('screenPlay').onclick();
tick(100);
assert.equal($('countdown').textContent, '3');
tick(2300);
assert.equal($('countdown').textContent, '1');
tick(3000);
tick(3060);
assert.equal($('countdown').hidden, true);
const pos = () => parseFloat($('copy').style.transform.slice(11));
assert.ok(pos() < 0);
listeners.get('keydown')({command:'toggle', target:{}, preventDefault:noop});
tick(3120);
assert.equal($('screenPlay').textContent, 'Avvia');
const paused = pos();
gamepad(null, 0.75);
tick(3180);
assert.ok(pos() < paused);
const jogged = pos();
tick(3400);
assert.equal(pos(), jogged);
moman(0, ['toggle']);
tick(3450);
assert.equal($('countdown').hidden, true);
assert.ok(pos() < jogged);
moman(0, ['home']);
tick(3500);
assert.equal(pos(), 0);
moman(0, ['toggle']);
tick(3550);
assert.equal($('countdown').textContent, '3');
tick(6500);
tick(6560);
assert.equal($('countdown').hidden, true);
assert.ok(pos() < 0);
const tap = (milliseconds, interactive = false) => {
  now += milliseconds;
  click({target:{closest:() => interactive}});
};
for (let i = 0; i < 4; i++) tap(120);
assert.equal($('momanControls').hidden, true);
tap(700);
tap(120, true);
for (let i = 0; i < 3; i++) tap(120);
assert.equal($('momanControls').hidden, true);
tap(120);
assert.equal($('momanControls').hidden, false);
console.log('Countdown, pausa/ripresa, stick e gesto di cinque clic verificati.');

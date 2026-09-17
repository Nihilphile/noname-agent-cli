'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PAGE_HELPER, ENTRY_READY_EXPRESSION, buildBootstrapExpression, bootstrapMain } = require('../src/native-bootstrap.cjs');
test('bootstrap changes only original local app entry and preserves existing preloads', () => {
  const app = new EventEmitter(); app.isReady = () => false;
  const urls = [], existing = ['original-preload']; let preloads;
  class BrowserWindow { loadURL(url, options) { urls.push({ url, options }); return 'original return'; } }
  const electron = { app, BrowserWindow, session: { defaultSession: { getPreloads: () => existing, setPreloads: value => { preloads = value; } } } };
  const expression = buildBootstrapExpression('C:/cli/native-bootstrap.cjs');
  assert.equal(vm.runInNewContext(expression, { require: id => { assert.equal(id, 'electron'); return electron; }, URL }).installed, true);
  app.emit('ready'); assert.deepEqual(Array.from(preloads), ['original-preload', 'C:/cli/native-bootstrap.cjs']);
  const window = new BrowserWindow(); assert.equal(window.loadURL('http://localhost:8089/app.html', { a: 1 }), 'original return');
  window.loadURL('http://localhost:8089/other.html'); window.loadURL('https://example.org/app.html');
  assert.equal(urls[0].url, 'http://localhost:8089/index.html'); assert.equal(urls[1].url, 'http://localhost:8089/other.html'); assert.equal(urls[2].url, 'https://example.org/app.html');
});
test('alert preload records errors while unknown confirms delegate to the actual native decision', () => {
  let alerts = 0, confirms = 0;
  const window = { alert: () => { alerts++; }, confirm: () => { confirms++; return false; }, addEventListener() {} };
  vm.runInNewContext(PAGE_HELPER, { window, console: { warn() {} } });
  window.alert('fatal diagnostic'); assert.equal(alerts, 0); assert.equal(window.__oneshotDiagnostics[0].message, 'fatal diagnostic');
  assert.equal(window.confirm('Some unknown decision?'), false); assert.equal(confirms, 1);
});
test('main debugger installs before resuming the paused Electron entry', async () => {
  const calls = []; let listener;
  const cdp = {
    onEvent: fn => { listener = fn; return () => {}; }, close() { calls.push('close'); },
    send: async (method, params) => {
      calls.push(method);
      if (method === 'Runtime.runIfWaitingForDebugger') listener({ method: 'Debugger.paused', params: { callFrames: [{ callFrameId: 'entry' }] } });
      if (method === 'Debugger.evaluateOnCallFrame') { assert.equal(params.callFrameId, 'entry'); return { result: { value: { installed: true } } }; }
      return {};
    },
  };
  assert.equal((await bootstrapMain({ port: 9229, connectCDP: async () => cdp, fetchJSON: async () => [{ webSocketDebuggerUrl: 'ws://main' }] })).installed, true);
  assert.deepEqual(calls, ['Debugger.enable', 'Runtime.runIfWaitingForDebugger', 'Debugger.evaluateOnCallFrame', 'Debugger.resume', 'close']);
});
test('entry readiness requires parsed index and actual bare-module mappings', () => {
  const document = { readyState: 'loading', querySelectorAll: () => [{ textContent: '{"imports":{"vue":"/vue.js","noname":"/noname.js"}}' }] };
  const location = { href: 'http://localhost:8089/index.html' };
  const check = () => vm.runInNewContext(ENTRY_READY_EXPRESSION, { document, location, URL });
  assert.equal(check(), false);
  document.readyState = 'interactive'; assert.equal(check(), true);
  location.href = 'http://localhost:8089/app.html'; assert.equal(check(), false);
  location.href = 'http://localhost:8089/index.html'; document.querySelectorAll = () => [{ textContent: '{}' }]; assert.equal(check(), false);
});

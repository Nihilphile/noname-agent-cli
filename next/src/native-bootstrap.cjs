'use strict';
// This file doubles as an Electron session preload. It lives with the CLI;
// installing it for one owned process changes no game source or user settings.
function pageHelper() {
  if (window.__oneshotNativeDialogInstalled) return;
  window.__oneshotNativeDialogInstalled = true;
  window.__oneshotDiagnostics = window.__oneshotDiagnostics || [];
  const record = (type, message) => {
    window.__oneshotDiagnostics.push({ type, message: String(message), at: Date.now() });
    if (window.__oneshotDiagnostics.length > 100) window.__oneshotDiagnostics.shift();
  };
  window.alert = message => { record('alert', message); console.warn('Game alert:', message); };
  const originalConfirm = window.confirm.bind(window);
  window.confirm = message => { record('confirm', message); return originalConfirm(message); };
  window.addEventListener('error', event => record('error', event.message));
  window.addEventListener('unhandledrejection', event => record('rejection', event.reason?.stack || event.reason));
}
const PAGE_HELPER = `(${pageHelper.toString()})();`;
// CDP navigation completion precedes HTML parsing. Importing a game module in
// that interval resolves bare specifiers without the document's import map and
// can poison this document's module graph with a cached resolution failure.
// This probe MUST remain module-free and be checked before every first import.
const ENTRY_READY_EXPRESSION = `(() => {
  if (document.readyState === 'loading') return false;
  const url = new URL(location.href);
  if (url.pathname !== '/index.html') return false;
  return Array.from(document.querySelectorAll('script[type="importmap"]')).some(script => {
    try { const imports = JSON.parse(script.textContent).imports; return typeof imports?.vue === 'string' && typeof imports?.noname === 'string'; }
    catch { return false; }
  });
})()`;
if (typeof process !== 'undefined' && process.type === 'renderer' && typeof window !== 'undefined') pageHelper();

function buildBootstrapExpression(preloadPath) {
  return `(() => {
    const electron = require('electron');
    const preload = ${JSON.stringify(preloadPath)};
    if (!electron.app.__oneshotNativeBootstrap) {
      electron.app.__oneshotNativeBootstrap = true;
      const original = electron.BrowserWindow.prototype.loadURL;
      electron.BrowserWindow.prototype.loadURL = function(url, ...args) {
        let destination = url;
        try {
          const parsed = new URL(url);
          if (parsed.protocol === 'http:' && ['localhost','127.0.0.1'].includes(parsed.hostname) && parsed.port === '8089' && parsed.pathname === '/app.html') {
            parsed.pathname = '/index.html'; destination = parsed.href;
          }
        } catch {}
        return original.call(this, destination, ...args);
      };
      const install = () => {
        const session = electron.session.defaultSession;
        const current = session.getPreloads();
        if (!current.includes(preload)) session.setPreloads([...current, preload]);
      };
      if (electron.app.isReady()) install();
      else electron.app.once('ready', install);
    }
    return {installed: true, entry: 'http://localhost:8089/index.html', preload};
  })()`;
}

async function bootstrapMain({ port, preloadPath = __filename, connectCDP, fetchJSON, timeoutMs = 15000 }) {
  const until = Date.now() + timeoutMs; let target, last;
  while (Date.now() < until && !target) {
    try { target = (await fetchJSON(`http://127.0.0.1:${port}/json/list`)).find(p => p.webSocketDebuggerUrl); } catch (e) { last = e; }
    if (!target) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!target) throw Object.assign(new Error(`Native main-process debugger did not become ready${last ? ': ' + last.message : ''}`), { code: 'native_bootstrap_timeout' });
  const cdp = await connectCDP(target.webSocketDebuggerUrl, { timeout: timeoutMs });
  let timer, unsubscribe;
  try {
    const paused = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Native main process did not pause before game entry.')), timeoutMs);
      unsubscribe = cdp.onEvent(event => { if (event.method === 'Debugger.paused') resolve(event.params); });
    });
    // Attach a rejection handler immediately, including while enable is pending.
    paused.catch(() => {});
    await cdp.send('Debugger.enable');
    await cdp.send('Runtime.runIfWaitingForDebugger');
    const frame = (await paused).callFrames?.[0];
    if (!frame) throw new Error('Native debugger did not provide a startup frame.');
    const result = await cdp.send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: buildBootstrapExpression(preloadPath), returnByValue: true });
    if (result.exceptionDetails || result.result?.value?.installed !== true) throw new Error(`Native runtime bootstrap failed: ${result.exceptionDetails?.exception?.description || result.exceptionDetails?.text || JSON.stringify(result.result)}`);
    await cdp.send('Debugger.resume');
    return result.result.value;
  } finally {
    clearTimeout(timer); unsubscribe?.(); cdp.close();
  }
}
module.exports = { PAGE_HELPER, ENTRY_READY_EXPRESSION, pageHelper, buildBootstrapExpression, bootstrapMain };

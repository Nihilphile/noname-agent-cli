'use strict';

// Node 22's built-in WebSocket keeps the standalone delivery dependency free.
async function connectCDP(url, { timeout = 15000 } = {}) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  const rejectAll = reason => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(reason); }
    pending.clear();
  };
  socket.addEventListener('message', event => {
    let packet;
    try { packet = JSON.parse(event.data); } catch { return; }
    if (packet.id) {
      const request = pending.get(packet.id);
      if (!request) return;
      pending.delete(packet.id); clearTimeout(request.timer);
      if (packet.error) request.reject(new Error(`CDP ${request.method}: ${packet.error.message}`));
      else request.resolve(packet.result);
    } else for (const listener of listeners) listener(packet);
  });
  socket.addEventListener('close', () => rejectAll(new Error('Client connection closed. Run status, then start a new session if needed.')));
  socket.addEventListener('error', () => rejectAll(new Error('Client connection failed. Run status to inspect the session.')));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Timed out connecting to the client.')); }, timeout);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Cannot connect to the client. Run status or restart the session.')); }, { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) return reject(new Error('Client connection is closed.'));
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out after ${timeout} ms.`)); }, timeout);
    pending.set(id, { resolve, reject, timer, method });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    send,
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Page evaluation failed.');
      return result.result?.value;
    },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { socket.close(); rejectAll(new Error('Connection closed by caller.')); },
  };
}

module.exports = { connectCDP };

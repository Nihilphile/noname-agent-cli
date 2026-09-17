'use strict';
const notifications = require('./notification.cjs');
const { submit } = require('./codex-delivery.cjs');
const page = require('./page.cjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const busy = e => e.code === 'operation_busy' || /Another .*operation|Another start\/stop/.test(e.message);

async function run(name, client, token) {
  if (!['native', 'isolated'].includes(client)) throw Error('Invalid client');
  const session = require(client === 'native' ? './native-session.cjs' : './session.cjs');
  const dir = session.sessionDir(name);
  let cdp, failures = 0;
  const startupDeadline = Date.now() + 3000;
  try {
    while (true) {
      const before = notifications.read(dir);
      if (!before?.enabled || token && before.workerToken !== token) break;
      if (before.workerPid !== process.pid) {
        if (token && before.workerPid == null && Date.now() < startupDeadline) { await sleep(25); continue; }
        break;
      }
      try {
        // Observations may take time. Feedback tokens discard a snapshot that
        // overlapped an act/restart; only the short durable transition is locked.
        let snapshot, error;
        try {
          if (!cdp) cdp = (await session.connect(name)).cdp;
          snapshot = await page.observe(cdp);
          if (snapshot.room && (!snapshot.room.connected || !snapshot.room.seatMatches)) throw Error('Room connection or seat changed; inspect room status before acting.');
          failures = 0;
        } catch (e) {
          cdp?.close(); cdp = null;
          if (++failures < 3) { await sleep(500); continue; }
          error = String(e.message).slice(0, 1000);
        }
        const prepared = await session.withLock(name, async () => {
          const current = notifications.read(dir);
          if (!current?.enabled || current.workerPid !== process.pid || token && current.workerToken !== token) return;
          const state = session.read(name);
          if (!state || state.cleanupComplete || notifications.identity(state) !== current.sessionIdentity) { notifications.disable(dir, 'session_changed'); return; }
          return notifications.prepareTick(dir, { snapshot, error, session: state, sessionName: name, client, feedback: before.feedback });
        });
        if (prepared?.item) {
          let result;
          try { result = await submit(prepared.binding, prepared.message); }
          catch (e) { result = { state: 'uncertain', outcome: 'submit_exception', error: e.message }; }
          // Never re-submit while waiting for an act/plan to release the lock.
          while (true) {
            try {
              await session.withLock(name, async () => {
                const delivered = notifications.finishTick(dir, prepared, result);
                if (delivered) session.appendEvidence(name, { command: 'notification', output: { id: delivered.id, kind: delivered.kind, state: delivered.state, revision: delivered.revision, outcome: delivered.outcome } });
              }); break;
            } catch (e) { if (!busy(e)) throw e; await sleep(100); }
          }
        }
      } catch (error) {
        if (!busy(error)) throw error;
      }
      await sleep(500);
    }
  } finally { cdp?.close(); }
}
if (require.main === module) run(...process.argv.slice(2)).catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { run };

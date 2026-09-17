'use strict';

// Observation only. The caller owns the connection, operation lock and feedback
// cursors; this helper never dispatches an action or consumes a notification.
async function waitAfterAction(output, adapter, { seconds = 15, pollMs = 250, readTimeoutMs = 1000 } = {}) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new RangeError('--wait-seconds 应在 1..60 范围内。');
  const now = adapter.now || Date.now;
  const started = now(), deadline = started + seconds * 1000;
  let state = output?.state;
  const finish = (status, extra = {}) => ({ ...output, state, wait: { status, seconds, elapsedMs: Math.max(0, now() - started), ...extra } });
  if (output?.ok !== true) return finish('skipped', { reason: 'action_failed' });
  output = { ...output, actionOutcome: 'completed', stateFresh: true };
  const terminal = value => ['choice', 'dead', 'over'].includes(value?.state);
  if (terminal(state)) return finish('ready', { reason: state.state });
  const epoch = value => value?.revision?.split(':')[0];
  const initial = { revision: epoch(state), log: state?.log?.epoch, event: state?.experimentalLog?.epoch };
  const fail = (code, message) => {
    output = { ...output, ok: false, code, message, stateFresh: false };
    return finish('error', { reason: code });
  };
  const confirm = next => {
    if (!next?.revision || !['running', 'choice', 'dead', 'over'].includes(next.state)) {
      throw Object.assign(Error('等待期间未取得有效对局快照；动作已完成，请 observe 核实。'), { code: 'wait_observation_failed' });
    }
    if (epoch(next) !== initial.revision || initial.log && next.log?.epoch !== initial.log || initial.event && next.experimentalLog?.epoch !== initial.event) {
      throw Object.assign(Error('等待期间对局或日志 epoch 已变化；保留原动作结果，请 observe 核实新对局。'), { code: 'session_changed' });
    }
    state = next;
  };
  async function observeWithin(ms) {
    let timer;
    try {
      const next = await Promise.race([
        Promise.resolve().then(() => adapter.observe()),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error('等待观察未在读取时限内完成；动作已完成，不会重放。'), { code: 'wait_observation_failed' })), ms); }),
      ]);
      confirm(next);
    } finally { clearTimeout(timer); }
  }
  try {
    if (state?.state !== 'running' || !initial.revision) return fail('wait_observation_failed', '动作已完成，但返回状态无法用于等待；请 observe 核实。');
    while (now() < deadline) {
      await observeWithin(Math.min(readTimeoutMs, deadline - now()));
      if (terminal(state)) return finish('ready', { reason: state.state });
      const remaining = deadline - now();
      if (remaining > 0) await adapter.sleep(Math.min(pollMs, remaining));
    }
    // The last sleep may contain a new decision. Confirm once at the deadline;
    // a hung read is an observation failure, never a normal running timeout.
    await observeWithin(readTimeoutMs);
    return terminal(state) ? finish('ready', { reason: state.state }) : finish('timeout', { reason: 'running' });
  } catch (error) {
    return fail(error.code === 'session_changed' ? error.code : 'wait_observation_failed', error.message || '等待观察失败；动作已完成，请 observe 核实。');
  }
}

function waitText(wait) {
  if (!wait) return '';
  if (wait.status === 'timeout') return '动作已完成；等待超时，当前 running。可再次 wait 或等待订阅通知。';
  if (wait.status === 'error') return '动作已完成；等待失败，保留的快照不是当前状态。请 observe 核实，不要重放动作。';
  if (wait.status === 'skipped') return '动作未全部成功，未继续等待；已完成步骤保留。';
  return `动作已完成；等待结束：${wait.reason}。`;
}

module.exports = { waitAfterAction, waitText };

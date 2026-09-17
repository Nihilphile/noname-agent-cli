'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Display receipts are local CLI presentation state. Page observations and the
// notification worker never read or mutate them. Missing/unusable receipts show
// the board again rather than suppressing feedback or failing a completed act.
function read(file, epoch) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value.version === 1 && value.epoch === epoch && Array.isArray(value.shownPhases) && value.shownPhases.every(id => typeof id === 'string') ? value.shownPhases : [];
  } catch { return []; }
}

function prepare(dir, value, display, { json = false } = {}) {
  const options = { ...display, state: display.state === 'auto' ? 'show' : display.state };
  const snapshot = value?.revision ? value : value?.state;
  const epoch = typeof snapshot?.revision === 'string' ? snapshot.revision.split(':')[0] : null;
  const phaseId = snapshot?.phaseId;
  const result = { options, commit() {} };
  if (!dir || options.state === 'hide' || !snapshot || ['setup', 'dead', 'over'].includes(snapshot.state)) return result;
  if (value?.stateFresh === false) return result;

  // Auto cadence is only suppressible when the snapshot identifies whose turn
  // and phase this is. Incomplete context fails open so useful state is never
  // hidden on an inference.
  if (!snapshot.me?.id || !Array.isArray(snapshot.players) || !snapshot.actor || !snapshot.phase) return result;
  if (display.state === 'auto' && snapshot.actor !== snapshot.me.id) return result;
  if (display.state === 'auto' && snapshot.phase !== 'phaseUse') { options.state = 'hide'; return result; }
  if (snapshot.phase !== 'phaseUse') return result;
  if (!epoch || typeof phaseId !== 'string' || !phaseId.startsWith(`${epoch}:phaseUse:`)) return result;

  // Running feedback inside our play phase is not the first decision. Keep the
  // receipt available until an actual choice is successfully printed.
  if (snapshot.state !== 'choice' || !snapshot.choice) {
    if (display.state === 'auto') options.state = 'hide';
    return result;
  }

  const file = path.join(dir, 'display-feedback.json');
  if (display.state === 'auto' && read(file, epoch).includes(phaseId)) { options.state = 'hide'; return result; }
  if (json || value?.ok === false) return result;
  result.commit = () => {
    // Re-read after output so another feedback's already-recorded phase is not
    // erased. If two readers race, a repeated board is safer than a lost first.
    const shownPhases = read(file, epoch);
    if (shownPhases.includes(phaseId)) return;
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(temp, JSON.stringify({ version: 1, epoch, shownPhases: [...shownPhases, phaseId] }) + '\n', { flag: 'wx' });
      fs.renameSync(temp, file);
    } catch {
      // A presentation receipt must not discard successful game feedback.
    } finally { try { fs.unlinkSync(temp); } catch {} }
  };
  return result;
}

module.exports = { prepare };

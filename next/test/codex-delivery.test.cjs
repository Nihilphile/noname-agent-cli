'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveBinding, submit, runBounded } = require('../src/codex-delivery.cjs');
const THREAD = '01a07d0a-a58a-7c00-bae4-8d8bf281d178';
const OTHER = '01a09020-4c9e-7581-840a-bd99d783bb70';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noname-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile');
  fs.mkdirSync(path.join(profile, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'state_5.sqlite'), 'fixture');
  const bin = path.join(root, 'OpenAI', 'Codex', 'bin');
  const exe = path.join(bin, 'install-one', 'codex.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, 'fixture');
  const calls = [];
  const env = { LOCALAPPDATA: root, CODEX_HOME: profile, CODEX_THREAD_ID: THREAD };
  const state = { version: 'codex-cli 0.154.0-alpha.6.2', help: 'Usage: codex queue --thread <THREAD> --message <MESSAGE>', result: { exitCode: 0, output: `Queued message receipt-1 for thread ${THREAD}.` } };
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === '--version') return { exitCode: 0, output: state.version };
    if (args.includes('--help')) return { exitCode: 0, output: state.help };
    return state.result;
  };
  return { root, profile, bin, exe, env, calls, state, context: { env, runner, platform: 'win32' } };
}

test('resolve pins discovered Desktop executable, profile, explicit or environment thread', async t => {
  const f = fixture(t);
  const binding = await resolveBinding({}, f.context);
  assert.equal(binding.thread_id, THREAD);
  assert.equal(binding.adapter.executable_path, fs.realpathSync.native(f.exe));
  assert.equal(binding.profile.path, fs.realpathSync.native(f.profile));
  assert.equal(binding.capabilities.consumption_confirmation, false);
  assert.equal(binding.capabilities.acceptance, 'capability-probed');
  assert.deepEqual(f.calls.map(call => call.args), [['--version'], ['queue', '--help']]);
  f.env.CODEX_SESSION_ID = OTHER;
  await assert.rejects(resolveBinding({}, f.context), { code: 'delivery_target_ambiguous' });
  assert.equal((await resolveBinding({ threadId: OTHER }, f.context)).thread_id, OTHER);
  await assert.rejects(resolveBinding({ threadId: '../../bad' }, f.context), { code: 'invalid_delivery_target' });
});

test('rejects missing profile, unsupported platform/version/help and ambiguous executable', async t => {
  const f = fixture(t);
  await assert.rejects(resolveBinding({}, { ...f.context, platform: 'linux' }), { code: 'unsupported_delivery_platform' });
  await assert.rejects(resolveBinding({ profilePath: f.root }, f.context), { code: 'delivery_profile_unverified' });
  f.state.version = 'codex-cli 99.0.0';
  await assert.rejects(resolveBinding({}, f.context), { code: 'delivery_capability_unverified' });
  f.state.version = 'codex-cli 0.153.4';
  assert.equal((await resolveBinding({}, f.context)).adapter.version, f.state.version);
  f.state.help = 'unrelated command --thread';
  await assert.rejects(resolveBinding({}, f.context), { code: 'delivery_capability_unverified' });
  const extra = path.join(f.bin, 'install-two', 'codex.exe');
  fs.mkdirSync(path.dirname(extra)); fs.writeFileSync(extra, 'fixture');
  await assert.rejects(resolveBinding({}, f.context), { code: 'delivery_executable_ambiguous' });
  f.state.help = 'queue --thread --message';
  await resolveBinding({ executablePath: f.exe }, f.context);
  await assert.rejects(resolveBinding({ executablePath: process.execPath }, f.context), { code: 'invalid_delivery_executable' });
});

test('queue submits literal arguments and fixed profile after caller environment changes', async t => {
  const f = fixture(t);
  const binding = await resolveBinding({}, f.context);
  const message = 'decision "quoted" `$(danger)`\nnext; & line';
  const result = await submit(binding, message, { ...f.context, env: { ...f.env, CODEX_HOME: 'drift', CODEX_THREAD_ID: OTHER } });
  assert.equal(result.state, 'accepted'); assert.equal(result.receipt, 'receipt-1');
  const call = f.calls.at(-1);
  assert.equal(call.command, binding.adapter.executable_path);
  assert.deepEqual(call.args, ['queue', '--thread', THREAD, '--message', message]);
  assert.equal(call.options.env.CODEX_HOME, binding.profile.path);
});

test('queue outcomes distinguish not started from possible side effects and never retry', async t => {
  const f = fixture(t);
  const binding = await resolveBinding({}, f.context);
  const examples = [
    [{ exitCode: 0, output: `Queued message receipt-2 for thread ${OTHER}.` }, 'uncertain', 'unknown_output_or_exit'],
    [{ exitCode: 1, output: 'failed' }, 'uncertain', 'unknown_output_or_exit'],
    [{ exitCode: null, timedOut: true, output: '' }, 'uncertain', 'timeout'],
    [{ exitCode: null, spawnError: { code: 'ENOENT' }, started: false }, 'not_started', 'spawn_not_started'],
    [{ exitCode: null, spawnError: { code: 'EIO' }, started: true }, 'uncertain', 'unknown_output_or_exit'],
  ];
  for (const [response, state, outcome] of examples) {
    f.state.result = response;
    const before = f.calls.filter(call => call.args.includes('--message')).length;
    const result = await submit(binding, 'decision', f.context);
    assert.equal(result.state, state); assert.equal(result.outcome, outcome);
    assert.equal(f.calls.filter(call => call.args.includes('--message')).length, before + 1);
  }
});

test('profile replacement or executable drift pauses before queue submission', async t => {
  const f = fixture(t);
  const binding = await resolveBinding({}, f.context);
  // Normal SQLite writes may grow the file; that is not a profile replacement.
  fs.appendFileSync(path.join(f.profile, 'state_5.sqlite'), 'normal write');
  assert.equal((await submit(binding, 'first', f.context)).state, 'accepted');
  f.state.version = 'codex-cli 0.153.4';
  assert.equal((await submit(binding, 'second', f.context)).outcome, 'delivery_capability_changed');
  f.state.version = binding.adapter.version;
  fs.appendFileSync(f.exe, 'upgrade');
  assert.equal((await submit(binding, 'third', f.context)).outcome, 'delivery_executable_changed');
  fs.renameSync(f.profile, `${f.profile}-old`);
  fs.mkdirSync(path.join(f.profile, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(f.profile, 'state_5.sqlite'), 'replacement');
  assert.equal((await submit(binding, 'fourth', f.context)).outcome, 'delivery_profile_changed');
  assert.equal(f.calls.filter(call => call.args.includes('--message')).length, 1);
});

test('invalid binding and oversized or NUL message never reach runner', async t => {
  const f = fixture(t);
  const binding = await resolveBinding({}, f.context);
  assert.equal((await submit(null, 'x', f.context)).state, 'paused');
  assert.equal((await submit(binding, 'x\0y', f.context)).outcome, 'invalid_message');
  assert.equal((await submit(binding, 'x'.repeat(24001), f.context)).outcome, 'invalid_message');
  assert.equal(f.calls.filter(call => call.args.includes('--message')).length, 0);
});

test('real runner bounds child wait and treats missing executable as not started', async () => {
  const missing = await runBounded(path.join(os.tmpdir(), 'nonexistent-noname-executable-820184.exe'), [], { timeoutMs: 1000 });
  assert.equal(missing.started, false); assert.ok(missing.spawnError);
  const timeout = await runBounded(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 80 });
  assert.equal(timeout.timedOut, true);
  const literal = '$(never-execute); "text"';
  const echoed = await runBounded(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal]);
  assert.equal(echoed.exitCode, 0); assert.equal(echoed.output, literal);
});

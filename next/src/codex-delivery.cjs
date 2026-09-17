'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUPPORTED_VERSIONS = Object.freeze(['codex-cli 0.153.4', 'codex-cli 0.154.0-alpha.6.2']);
const clean = value => String(value || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
function fail(code, message) { throw Object.assign(new Error(message), { code }); }

// The runner never uses a shell, and resolves even if a killed process does not close.
function runBounded(command, args, { env = process.env, timeoutMs = 5000 } = {}) {
  return new Promise(resolve => {
    let child, timer, settled = false, started = false, bytes = 0;
    const chunks = [];
    const finish = extra => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ exitCode: null, timedOut: false, started, output: Buffer.concat(chunks).toString('utf8'), ...extra });
    };
    try { child = spawn(command, args, { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { finish({ spawnError: { code: error.code, message: error.message } }); return; }
    child.once('spawn', () => { started = true; });
    const collect = chunk => {
      const buffer = Buffer.from(chunk);
      if (bytes < 16384) chunks.push(buffer.subarray(0, 16384 - bytes));
      bytes += buffer.length;
      if (bytes > 16384) { child.kill(); finish({ outputLimit: true }); }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', error => finish({ spawnError: { code: error.code, message: error.message } }));
    child.once('close', (exitCode, signal) => finish({ exitCode, signal }));
    timer = setTimeout(() => { child.kill(); finish({ timedOut: true }); }, timeoutMs);
  });
}

function identity(file, directory) {
  const realpath = fs.realpathSync.native(file);
  const stat = fs.statSync(realpath);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('Unexpected filesystem type');
  return { path: realpath, dev: stat.dev, ino: stat.ino, ...(directory ? {} : { size: stat.size, mtimeMs: stat.mtimeMs }) };
}
function sameIdentity(expected, directory, mutable = false) {
  try {
    const actual = identity(expected.path, directory);
    return actual.path === expected.path && actual.dev === expected.dev && actual.ino === expected.ino
      && (directory || mutable || actual.size === expected.size && actual.mtimeMs === expected.mtimeMs);
  } catch { return false; }
}
function profileAt(value) {
  try {
    const root = identity(value, true);
    const database = identity(path.join(root.path, 'state_5.sqlite'), false);
    const sessions = identity(path.join(root.path, 'sessions'), true);
    return { path: root.path, root, database, sessions };
  } catch { fail('delivery_profile_unverified', 'Codex profile must contain state_5.sqlite and a sessions directory.'); }
}
function desktopRoot(env) {
  if (!env.LOCALAPPDATA) fail('delivery_executable_missing', 'LOCALAPPDATA is required to find the Desktop installation.');
  try { return fs.realpathSync.native(path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')); }
  catch { fail('delivery_executable_missing', 'No Codex Desktop bin directory was found.'); }
}
function validateExecutable(file, root) {
  try {
    const info = identity(file, false);
    const relative = path.relative(root, info.path);
    if (path.isAbsolute(relative) || !/^[^\\/]+[\\/]codex\.exe$/i.test(relative) || relative.startsWith('..')) throw new Error('Outside installation');
    return info;
  } catch { fail('invalid_delivery_executable', 'Use the exact codex.exe inside the Codex Desktop bin installation.'); }
}
async function inspect(executable, profilePath, env, runner) {
  const pinnedEnv = { ...env, CODEX_HOME: profilePath };
  const versionResult = await runner(executable, ['--version'], { env: pinnedEnv, timeoutMs: 5000 });
  const version = clean(versionResult.output);
  if (versionResult.spawnError || versionResult.timedOut || versionResult.exitCode !== 0 || !SUPPORTED_VERSIONS.includes(version)) return { ok: false, version };
  const help = await runner(executable, ['queue', '--help'], { env: pinnedEnv, timeoutMs: 5000 });
  const output = clean(help.output);
  return { ok: !help.spawnError && !help.timedOut && help.exitCode === 0 && /\bqueue\b/i.test(output) && /--thread\b/.test(output) && /--message\b/.test(output), version };
}

async function resolveBinding(options = {}, context = {}) {
  const env = context.env || process.env;
  if ((context.platform || process.platform) !== 'win32') fail('unsupported_delivery_platform', 'Codex Desktop notifications currently support Windows only.');
  const explicit = options.threadId ?? options.thread ?? options.notifyThread;
  const first = env.CODEX_THREAD_ID?.toLowerCase(), second = env.CODEX_SESSION_ID?.toLowerCase();
  if (explicit === undefined && first && second && first !== second) fail('delivery_target_ambiguous', 'CODEX_THREAD_ID and CODEX_SESSION_ID disagree; supply an explicit thread UUID.');
  const threadId = String(explicit ?? first ?? second ?? '').toLowerCase();
  if (!UUID.test(threadId)) fail('invalid_delivery_target', 'Notifications require an exact Codex task UUID.');
  const profile = profileAt(path.resolve(options.profilePath || env.CODEX_HOME || path.join(env.USERPROFILE || os.homedir(), '.codex')));
  const root = desktopRoot(env);
  let executable = options.executablePath ?? options.desktopExecutable ?? env.NONAME_CODEX_DESKTOP_EXECUTABLE;
  if (!executable) {
    const candidates = fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory())
      .map(item => path.join(root, item.name, 'codex.exe')).filter(file => fs.existsSync(file));
    if (!candidates.length) fail('delivery_executable_missing', 'No Desktop codex.exe was found.');
    if (candidates.length !== 1) fail('delivery_executable_ambiguous', 'Multiple Desktop executables exist; supply --desktop-executable.');
    [executable] = candidates;
  }
  if (!path.isAbsolute(executable)) fail('invalid_delivery_executable', 'Desktop executable must be an absolute path.');
  const pinned = validateExecutable(executable, root);
  const capability = await inspect(pinned.path, profile.path, env, context.runner || runBounded);
  if (!capability.ok) fail('delivery_capability_unverified', `Desktop queue capability check failed (${capability.version || 'unknown version'}).`);
  return { schema: 1, host: 'codex-desktop', thread_id: threadId, profile,
    adapter: { executable_path: pinned.path, identity: pinned, install_root: root, version: capability.version },
    capabilities: { next_turn: true, same_turn: false, consumption_confirmation: false, acceptance: 'capability-probed' } };
}

async function submit(binding, message, context = {}) {
  const paused = outcome => ({ state: 'paused', host_acceptance: 'not_attempted', outcome });
  if (!binding || binding.schema !== 1 || binding.host !== 'codex-desktop' || !UUID.test(binding.thread_id || '')) return paused('invalid_binding');
  if (typeof message !== 'string' || !message || message.includes('\0') || Buffer.byteLength(message, 'utf8') > 24000) return paused('invalid_message');
  const profile = binding.profile, adapter = binding.adapter;
  if (!profile || !adapter || !profile.root || !profile.database || !profile.sessions || !adapter.identity) return paused('invalid_binding');
  if (profile.path !== profile.root.path || !sameIdentity(profile.root, true) || !sameIdentity(profile.database, false, true) || !sameIdentity(profile.sessions, true)) return paused('delivery_profile_changed');
  if (adapter.executable_path !== adapter.identity.path || !sameIdentity(adapter.identity, false)) return paused('delivery_executable_changed');
  try { validateExecutable(adapter.executable_path, adapter.install_root); }
  catch { return paused('delivery_executable_changed'); }
  const env = { ...(context.env || process.env), CODEX_HOME: profile.path };
  const runner = context.runner || runBounded;
  let capability;
  try { capability = await inspect(adapter.executable_path, profile.path, env, runner); }
  catch { return paused('delivery_capability_unverified'); }
  if (!capability.ok || capability.version !== adapter.version) return paused('delivery_capability_changed');
  let result;
  try { result = await runner(adapter.executable_path, ['queue', '--thread', binding.thread_id, '--message', message], { env, timeoutMs: context.timeoutMs ?? 15000 }); }
  catch { return { state: 'uncertain', host_acceptance: 'uncertain', outcome: 'runner_error' }; }
  if (result.spawnError && result.started !== true) return { state: 'not_started', host_acceptance: 'not_attempted', outcome: 'spawn_not_started', code: result.spawnError.code || null };
  const match = /^Queued message ([^\r\n]{1,256}) for thread ([0-9a-f-]{36})\.$/iu.exec(clean(result.output));
  if (!result.spawnError && !result.timedOut && result.exitCode === 0 && match && match[2].toLowerCase() === binding.thread_id) {
    return { state: 'accepted', host_acceptance: 'accepted', outcome: 'queue_accepted', receipt: match[1], submission_receipt: match[1] };
  }
  return { state: 'uncertain', host_acceptance: 'uncertain', outcome: result.timedOut ? 'timeout' : 'unknown_output_or_exit', exit_code: result.exitCode ?? null };
}

module.exports = { resolveBinding, submit, runBounded, SUPPORTED_VERSIONS };

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const DEFAULTS = Object.freeze({ logs: 'compact', state: 'auto' });
const CONFIG_PATH = path.resolve(__dirname, '..', '.noname-agent.json');
const ALLOWED = { logs: ['classic', 'compact', 'experimental', 'raw'], state: ['auto', 'show', 'hide'] };

function validate(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('显示配置必须是 JSON 对象。');
  for (const [key, value] of Object.entries(config)) {
    if (!Object.hasOwn(ALLOWED, key) || !ALLOWED[key].includes(value)) throw new Error(`无效显示配置 ${key}=${value}；支持 logs=classic|compact|experimental（raw 为 classic 别名）、state=auto|show|hide。`);
  }
  const value = { ...DEFAULTS, ...config };
  if (value.logs === 'raw') value.logs = 'classic';
  return value;
}
function read(file = CONFIG_PATH) {
  try { return validate(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))); }
  catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULTS };
    throw new Error(`无法读取显示配置 ${file}：${error.message}`);
  }
}
function save(config, file = CONFIG_PATH) {
  const value = validate(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + `.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return value;
}
function resolve(config, options = {}) {
  if (options.raw && options.compact) throw new Error('--raw 与 --compact 不能同时使用。');
  if (options['log-mode'] !== undefined && (options.raw || options.compact)) throw new Error('--log-mode 与 --raw/--compact 不能同时使用。');
  if (options['log-mode'] !== undefined && !['classic', 'compact', 'experimental'].includes(options['log-mode'])) throw new Error('--log-mode 必须是 classic、compact 或 experimental。');
  if ([options.state_hide, options.state_show, options.state_auto].filter(Boolean).length > 1) throw new Error('--state_auto、--state_hide 与 --state_show 不能同时使用。');
  const value = validate(config);
  const logs = options['log-mode'] ?? (options.raw ? 'classic' : options.compact ? 'compact' : value.logs);
  return { logs, raw: logs === 'classic', state: options.state_hide ? 'hide' : options.state_show ? 'show' : options.state_auto ? 'auto' : options.detail && value.state === 'auto' ? 'show' : value.state };
}

// Presentation only: evidence, notification snapshots and action validation
// retain the original snapshot. Hidden is explicit; it never means no players.
function project(value, options = {}) {
  if (!value || typeof value !== 'object') return value;
  const present = state => {
    let result = state;
    if (Object.hasOwn(state, 'experimentalLog') || options.logs === 'experimental') {
      const { experimentalLog, ...rest } = state;
      result = rest;
      if (options.logs === 'experimental') result.log = experimentalLog ?? {
        available: false, reason: 'experimental_log_unavailable', coverage: 'experimental_partial',
        epoch: null, from: null, to: null, truncated: false, entries: [],
      };
      if (options.logs === 'experimental') delete result.recent;
    }
    if (options.state !== 'hide') return result;
    const { me, players, victory, ...rest } = result;
    return { ...rest, presentation: { ...(state.presentation || {}), state: 'hidden', hint: 'observe --state_show 查看完整场上情况' } };
  };
  if (value.revision) return present(value);
  if (value.state?.revision) {
    const state = present(value.state);
    return state === value.state ? value : { ...value, state };
  }
  return value;
}

module.exports = { DEFAULTS, CONFIG_PATH, validate, read, save, resolve, project };

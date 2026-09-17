#!/usr/bin/env node
'use strict';
// Offline registration inventory. Never invokes a skill's executable callbacks.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

function loadRegistration(app, folder, official = false) {
  app = path.resolve(app);
  const files = [], sources = [], errors = [], warnings = [], messages = [], packs = [];
  let context;
  const lib = { assetURL: app.replaceAll('\\', '/') + '/', group: [], groupnature: {}, translate: {}, config: { forbidai: [] }, skill: {}, character: {}, card: {}, arenaReady: [], init: {} };
  const status = { extension: folder };
  const game = {
    import(kind, factory) {
      const value = factory(lib, game, context.ui, context.get, context.ai, status);
      if (kind === 'extension') context.__extension = value;
      if (kind === 'character') {
        packs.push(value);
        Object.assign(lib.skill, value.skill); Object.assign(lib.character, value.character); Object.assign(lib.translate, value.translate);
      }
    },
    addGroup(id) { lib.group.push(id); },
    print(...args) { warnings.push(args.map(String).join(' ')); },
  };
  context = vm.createContext({ lib, game, _status: status, ui: {}, get: {}, ai: {}, console: { log: (...args) => messages.push(args.map(String).join(' ')), warn: (...args) => warnings.push(args.map(String).join(' ')), error: (...args) => warnings.push(args.map(String).join(' ')) } });
  context.window = context;
  function run(file) {
    const absolute = path.resolve(file);
    if (absolute !== app && !absolute.startsWith(app + path.sep)) throw new Error('Registration path escaped game app');
    try {
      const original = fs.readFileSync(absolute, 'utf8');
      sources.push({ file: path.relative(app, absolute).replaceAll('\\', '/'), source: original });
      files.push({ path: path.relative(app, absolute).replaceAll('\\', '/'), sha256: crypto.createHash('sha256').update(original).digest('hex') });
      // The official bundled standard pack has one engine import, no other imports.
      const source = official ? original.replace(/^import\s+\{[^\n]+\}\s+from\s+["']noname["'];?\s*$/m, '') : original;
      vm.runInContext(source, context, { filename: absolute, timeout: 4000 });
    } catch (error) { errors.push({ file: path.relative(app, absolute), message: error.message }); }
  }
  lib.init.jsSync = (base, name) => run(path.join(base, `${name}.js`));
  lib.init.js = (base, name, done) => { lib.init.jsSync(base, name); if (done) done(); };
  if (official) run(path.join(app, 'character', 'standard.js'));
  else {
    run(path.join(app, 'extension', folder, 'extension.js'));
    if (context.__extension?.precontent) {
      try { vm.runInContext('__extension.precontent()', context, { timeout: 15000 }); }
      catch (error) { errors.push({ file: `extension/${folder}/extension.js:precontent`, message: error.message }); }
    } else errors.push({ file: folder, message: 'No extension precontent registration callback' });
  }
  const skillOwners = {};
  for (const registry of [context.nihilModules, context.zusfylriModules]) for (const mod of Object.values(registry || {})) {
    const owners = Object.keys(mod.character || {});
    for (const id of Object.keys(mod.skill || {})) skillOwners[id] = owners;
  }
  return { packs, files, sources, errors, warnings, messages, skillOwners, forbidai: [...lib.config.forbidai] };
}

function functionsOf(value, prefix = '', seen = new Set()) {
  if (typeof value === 'function') return [{ field: prefix, source: Function.prototype.toString.call(value) }];
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  return Object.entries(value).flatMap(([key, nested]) => key === 'subSkill' ? [] : functionsOf(nested, prefix ? `${prefix}.${key}` : key, seen));
}
function strings(value) { return typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter(v => typeof v === 'string') : []; }
function uncomment(source) { return source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, token => token.startsWith('//') || token.startsWith('/*') ? ' ' : token); }
function classify(skill) {
  const functions = functionsOf(skill).map(v => ({ ...v, source: uncomment(v.source) })), source = functions.map(v => v.source).join('\n');
  const content = functions.filter(v => /^(content|precontent|contentBefore|contentAfter)(\.|$)/.test(v.field)).map(v => v.source).join('\n');
  const targetPatterns = [];
  const mark = (yes, label) => { if (yes) targetPatterns.push(label); };
  mark('filterTarget' in skill || 'selectTarget' in skill || 'multitarget' in skill, 'declarative-target-selection');
  mark(/\.chooseTarget\s*\(/.test(source), 'chooseTarget');
  mark(/\.chooseCardTarget\s*\(/.test(source), 'chooseCardTarget');
  mark(/(?:result|\w+[Rr]esult)\s*\.\s*targets\b|\{[^}\n]*\btargets\b[^}\n]*\}\s*=\s*await/.test(content), 'confirmed-result-targets');
  mark(/\b(?:event|trigger)\.targets?\b/.test(content), 'event-target-reference-not-necessarily-confirmed');
  mark(/\bevent\.targets\s*=/.test(content), 'event-target-list-write-may-be-candidate-pool');
  mark(/\bevent\.target\s*=/.test(content), 'late-singular-target-assignment');
  mark(/game\.(?:filterPlayer|filterPlayer2|players|countPlayer|findPlayer)|\.get(?:Next|Previous)\s*\(/.test(content), 'computed-or-player-iteration-targets');
  const styles = [];
  if (functions.some(v => /^async\b|\bawait\b/.test(v.source))) styles.push('async-await');
  if (/["']step\s+\d+["']/.test(content)) styles.push('legacy-step');
  if (skill.mod && !skill.content && !skill.trigger && !skill.enable) styles.push('mod-only-no-independent-activation');
  if (content && !styles.includes('async-await') && !styles.includes('legacy-step')) styles.push('synchronous-content');
  if (!content) styles.push('no-own-content');
  const statePatterns = [];
  const patterns = {
    'hp-maxhp': /\.(?:damage|recover|loseHp|loseMaxHp|gainMaxHp|changeHp)\s*\(|\.(?:hp|maxHp)\s*(?:[+\-*/]?=|\+\+|--)/,
    armor: /\.(?:changeHujia|hujia)\b/,
    'cards-or-zones': /\.(?:draw|gain|lose|discard|give|equip|addJudge|loseToDiscardpile|addToExpansion)\s*\(/,
    'marks-storage-expansions': /\.(?:addMark|removeMark|markSkill|unmarkSkill|storage|getExpansions|addToExpansion)\b/,
    'turnover-linked': /\.(?:turnOver|link)\s*\(/,
    'death-revival': /\.(?:die|revive)\s*\(/,
    'event-rule-modification': /\btrigger\.(?:cancel|untrigger|finish)\s*\(|\btrigger\.[\w]+\s*(?:[+\-*/]?=|\+\+|--)|\.(?:directHit|excluded)\b/,
  };
  for (const [name, regex] of Object.entries(patterns)) if (regex.test(source)) statePatterns.push(name);
  const risks = [];
  if (skill.direct || /\.chooseBool\s*\(/.test(content)) risks.push('content-entry-not-proof-of-activation');
  if (/\.(?:logSkill|line)\s*\(/.test(content)) risks.push('logSkill-line-are-signals-not-complete-target-proof');
  if (targetPatterns.includes('event-target-list-write-may-be-candidate-pool')) risks.push('candidate-pool-must-not-be-reported-as-selection');
  if (styles.includes('mod-only-no-independent-activation')) risks.push('continuous-modifier-needs-no-fabricated-activation');
  if (statePatterns.includes('marks-storage-expansions') || statePatterns.includes('turnover-linked')) risks.push('state-kind-outside-current-experimental-journal');
  if (skill.inherit) risks.push('inherited-behavior-must-resolve');
  const callSource = content.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, ' ');
  const freeCalls = [...new Set([...callSource.matchAll(/(?<![\w.$])([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]).filter(v => !['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'Boolean', 'Number', 'String', 'Object', 'Array', 'Math', 'parseInt', 'parseFloat', 'isNaN', 'setTimeout', ...functions.map(fn => fn.field.split('.').at(-1))].includes(v)))];
  if (freeCalls.length) risks.push('helper-call-or-local-function-body-not-resolved');
  if (content && !targetPatterns.length) risks.push('no-static-target-pattern-does-not-prove-targetless');
  const extractionPaths = [];
  if (skill.enable || skill.trigger || content) extractionPaths.push('named-skill-event-plus-activation-confirmation');
  if (skill.viewAs || skill.hiddenCard) extractionPaths.push('useCard-or-respond-explicit-skill-field');
  if (targetPatterns.some(p => p === 'chooseTarget' || p === 'chooseCardTarget')) extractionPaths.push('completed-choice-result-targets-ordered-batches');
  if (targetPatterns.includes('late-singular-target-assignment')) extractionPaths.push('post-execution-declared-target-not-confirmed-selection');
  if (statePatterns.some(p => ['hp-maxhp', 'armor', 'cards-or-zones', 'death-revival'].includes(p))) extractionPaths.push('public-state-sampling-between-events');
  if (styles.includes('mod-only-no-independent-activation')) extractionPaths.push('continuous-rule-no-independent-action');
  if (freeCalls.length) extractionPaths.push('helper-body-needs-further-analysis');
  return { styles, targetPatterns, statePatterns, risks, extractionPaths, logExpectation: styles.includes('mod-only-no-independent-activation') ? 'read-skill-description-no-activation-log' : 'runtime-public-operation-or-state', unresolvedHelperCalls: freeCalls, functionFields: functions.map(v => v.field), nativeLogSignal: /\b(?:game\.log|\w+\.logSkill|semanticLog)\s*\(/.test(content) };
}

function dependencies(id, skill) {
  const out = [];
  for (const field of ['group', 'global', 'inherit']) for (const to of strings(skill[field])) out.push({ from: id, to, kind: field });
  for (const name of Object.keys(skill.subSkill || {})) out.push({ from: id, to: `${id}_${name}`, kind: 'subSkill' });
  const unknown = [];
  for (const fn of functionsOf(skill)) {
    for (const match of uncomment(fn.source).matchAll(/\.(addSkill|addTempSkill|addSkills|addAdditionalSkill|addAdditionalSkills|addGlobalSkill)\s*\(([^;\n]*?)(?:\)|$)/g)) {
      const method = match[1], args = match[2];
      const arg = /Additional/.test(method) ? args.replace(/^\s*(?:["'][^"']*["']|[^,]+)\s*,\s*/, '') : args;
      const literal = /^\s*(["'])([^"']+)\1/.exec(arg);
      const array = /^\s*\[([^\]]*)\]/.exec(arg);
      if (literal) out.push({ from: id, to: literal[2], kind: method, field: fn.field });
      else if (array && !array[1].replace(/["'][^"']*["']|\s|,/g, '')) for (const item of array[1].matchAll(/["']([^"']+)["']/g)) out.push({ from: id, to: item[1], kind: method, field: fn.field });
      else unknown.push({ kind: 'dynamic-skill-dependency', method, field: fn.field, expression: args.slice(0, 180) });
    }
  }
  return { edges: out, unknown };
}

function inventory(loaded, packName, options = {}) {
  const skills = {}, characters = {}, translate = {};
  const skillOwners = { ...loaded.skillOwners };
  for (const pack of loaded.packs) { Object.assign(skills, pack.skill); Object.assign(characters, pack.character); Object.assign(translate, pack.translate); }
  function flatten(id, skill) { for (const [key, child] of Object.entries(skill.subSkill || {})) { const nested = `${id}_${key}`; if (!skills[nested]) skills[nested] = child; if (!skillOwners[nested]) skillOwners[nested] = skillOwners[id]; flatten(nested, child); } }
  for (const [id, skill] of Object.entries(skills)) flatten(id, skill);
  const registeredCharacterCount = Object.keys(characters).length;
  const included = [], excluded = [], records = {}, unknown = [];
  function locate(id, skill) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const key = new RegExp(`(?:^|[\\s,{])(?:["']${escaped}["']|${escaped})\\s*:`);
    for (const file of loaded.sources || []) { const match = key.exec(file.source); if (match) return { file: file.file, line: file.source.slice(0, match.index + match[0].search(/\S/)).split('\n').length, evidence: 'definition-key-match' }; }
    for (const fn of functionsOf(skill)) for (const file of loaded.sources || []) { const index = file.source.indexOf(fn.source); if (index >= 0) return { file: file.file, line: file.source.slice(0, index).split('\n').length, evidence: 'callback-source-match' }; }
    return null;
  }
  for (const [id, char] of Object.entries(characters)) {
    if (options.select && !options.select.includes(id)) continue;
    const roots = strings(Array.isArray(char) ? char[3] : char.skills);
    const flags = Array.isArray(char) ? char[4] || [] : char.trashBin || [];
    const forbidai = flags.includes('forbidai') || char.isAiForbidden === true || char.forbidai === true || loaded.forbidai.includes(id);
    const item = { id, label: translate[id] || id, roots, forbidai, skills: [] };
    if (options.excludeForbidai && forbidai) { excluded.push({ ...item, reason: 'forbidai metadata/runtime registration' }); continue; }
    const visited = new Set();
    function visit(skillId) {
      if (visited.has(skillId)) return; visited.add(skillId); item.skills.push(skillId);
      const skill = skills[skillId];
      if (!skill) { if (!records[skillId]) { records[skillId] = { id: skillId, missing: true }; unknown.push({ kind: 'unresolved-skill-definition', skill: skillId }); } return; }
      if (!records[skillId]) {
        const dep = dependencies(skillId, skill);
        records[skillId] = { id: skillId, label: translate[skillId] || skillId, source: locate(skillId, skill), description: translate[`${skillId}_info`] || null, ...classify(skill), dependencies: dep.edges, unknown: dep.unknown };
        unknown.push(...dep.unknown.map(v => ({ skill: skillId, ...v })));
      }
      for (const edge of records[skillId].dependencies) visit(edge.to);
    }
    roots.forEach(visit); included.push(item);
  }
  if (options.select) for (const id of options.select) if (!characters[id]) unknown.push({ kind: 'requested-official-character-missing', id });
  const excludedReachable = new Set();
  function visitExcluded(id) { if (excludedReachable.has(id)) return; excludedReachable.add(id); if (skills[id]) for (const edge of dependencies(id, skills[id]).edges) visitExcluded(edge.to); }
  excluded.flatMap(c => c.roots).forEach(visitExcluded);
  const excludedIds = new Set(excluded.map(c => c.id));
  const excludedModuleSkillIds = Object.keys(skills).filter(id => skillOwners[id]?.length && skillOwners[id].every(owner => excludedIds.has(owner)));
  const auxiliarySkills = options.select ? [] : Object.entries(skills).filter(([id]) => !records[id] && !excludedReachable.has(id) && !excludedModuleSkillIds.includes(id)).map(([id, skill]) => {
    const dep = dependencies(id, skill);
    unknown.push({ kind: 'registered-skill-without-resolved-owner', skill: id }, ...dep.unknown.map(v => ({ skill: id, ...v })));
    return { id, label: translate[id] || id, source: locate(id, skill), moduleOwners: skillOwners[id] || [], description: translate[`${id}_info`] || null, ...classify(skill), dependencies: dep.edges, unknown: dep.unknown };
  });
  const counts = { styles: {}, targetPatterns: {}, statePatterns: {}, risks: {} };
  for (const skill of [...Object.values(records), ...auxiliarySkills]) for (const group of Object.keys(counts)) for (const label of skill[group] || []) counts[group][label] = (counts[group][label] || 0) + 1;
  const unassignedRegisteredSkills = Object.keys(skills).filter(id => !records[id]);
  const rootAssessments = included.flatMap(character => character.roots.map(root => {
    const visited = new Set();
    function visit(id) { if (visited.has(id)) return; visited.add(id); for (const edge of records[id]?.dependencies || []) visit(edge.to); }
    visit(root);
    const reachable = [...visited].map(id => records[id]).filter(Boolean);
    const unique = field => [...new Set(reachable.flatMap(s => s[field] || []))];
    const rootSkill = records[root];
    const staticOnly = reachable.length > 0 && reachable.every(s => s.logExpectation === 'read-skill-description-no-activation-log');
    return { character: character.id, root, label: rootSkill?.label || root, source: rootSkill?.source || null, dependencies: [...visited].filter(id => id !== root), targetPatterns: unique('targetPatterns'), extractionPaths: unique('extractionPaths'), styles: unique('styles'), risks: unique('risks'), status: rootSkill?.missing ? 'external-unresolved' : staticOnly ? 'static-rule-description-no-activation-log-required' : 'static-pattern-inventory-only-runtime-unverified', unknownDependencies: reachable.filter(s => s.missing || s.unknown?.length).map(s => s.id) };
  }));
  return { pack: packName, registeredCharacterCount, included, excluded, rootAssessments, skills: Object.values(records), auxiliarySkills, counts, unknown, unassignedRegisteredSkills, registration: { files: loaded.files, errors: loaded.errors, warnings: loaded.warnings, messages: loaded.messages || [] }, summary: { includedCharacters: included.length, excludedCharacters: excluded.length, rootSkills: rootAssessments.length, reachableSkills: Object.keys(records).length, auxiliarySkillsWithoutResolvedOwner: auxiliarySkills.length, unresolvedSkills: Object.values(records).filter(v => v.missing).length, unassignedRegisteredSkills: unassignedRegisteredSkills.length, dynamicDependencyUnknowns: unknown.filter(v => v.kind === 'dynamic-skill-dependency').length, helperUnresolvedSkills: [...Object.values(records), ...auxiliarySkills].filter(v => v.unresolvedHelperCalls?.length).length, registrationErrors: loaded.errors.length, registrationWarnings: loaded.warnings.length } };
}

function markdown(report) {
  const lines = ['# 离线技能信息提取预检', '', `生成：${report.generatedAt}`, '', '**这是静态写法库存与风险预检，不是实际发动覆盖率或动态通过率。未启动游戏，未调用技能 content/filter/mod。**', '', '## 方法与边界', '', ...report.limitations.map(v => `- ${v}`), '', '## 汇总', '', '| 包 | 已注册武将 | 纳入 | 排除 | 可达技能 | 缺失定义 | 动态依赖 unknown | helper 未解析技能 | 注册错误/警告 |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const p of report.packs) { const s = p.summary; lines.push(`| ${p.pack} | ${p.registeredCharacterCount} | ${s.includedCharacters} | ${s.excludedCharacters} | ${s.reachableSkills} | ${s.unresolvedSkills} | ${s.dynamicDependencyUnknowns} | ${s.helperUnresolvedSkills} | ${s.registrationErrors}/${s.registrationWarnings} |`); }
  for (const p of report.packs) {
    lines.push('', `## ${p.pack}`, '', '### 排除名单', '', ...(p.excluded.length ? p.excluded.map(v => `- ${v.id} ${v.label}：${v.reason}`) : [p.pack === 'nihilphile' ? '无。nihil 包即使 forbidai 也全部纳入。' : '无。官方包仅抽取指定武将。']), '', '### 写法计数', '');
    for (const [group, counts] of Object.entries(p.counts)) lines.push(`- ${group}：${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('；') || '无识别项'}`);
    lines.push('', '### 武将 → 根技能 → 可达依赖', '', '| 武将 | 根技能 | 可达技能（含根） |', '|---|---|---|');
    for (const c of p.included) lines.push(`| ${c.id} ${c.label} | ${c.roots.join(', ')} | ${c.skills.join(', ')} |`);
    lines.push('', '### 每个根技能的提取路径预检（静态推断，非动态通过）', '', '| 武将 / 根技能 | 依赖 | 写法 / 目标路径 | 提取路径状态 | 源码 |', '|---|---|---|---|---|');
    for (const r of p.rootAssessments) lines.push(`| ${r.character} / ${r.root} ${r.label} | ${r.dependencies.join(', ') || '无静态依赖'} | ${[...r.styles, ...r.targetPatterns, ...r.extractionPaths].join(', ')} | ${r.status}${r.unknownDependencies.length ? '; unknown: ' + r.unknownDependencies.join(', ') : ''} | ${r.source ? r.source.file + ':' + r.source.line : 'unknown'} |`);
    lines.push('', '### 技能表达矩阵', '', '| 技能 | 写法 | 目标取得线索 | 状态线索 | 风险/unknown |', '|---|---|---|---|---|');
    for (const s of [...p.skills, ...p.auxiliarySkills]) lines.push(`| ${s.id}${p.auxiliarySkills.includes(s) ? ' (归属未解析，补充扫描)' : ''} | ${(s.styles || []).join(', ')} | ${(s.targetPatterns || []).join(', ')} | ${(s.statePatterns || []).join(', ')} | ${s.missing ? 'missing-definition' : [...s.risks, ...(s.unknown?.length ? [`dynamic-dependency:${s.unknown.length}`] : [])].join(', ')} |`);
    lines.push('', `补充扫描已注册但归属未解析的技能：${p.auxiliarySkills.map(s => s.id).join(', ') || '无'}。计数包含这些补充技能；排除武将专属依赖不补扫。`, '', `注册调试消息：${p.registration.messages.length} 条（JSON 保留，非错误）。`);
    lines.push('', '### 注册错误与警告', '', ...p.registration.errors.map(v => `- ERROR ${v.file}: ${v.message}`), ...p.registration.warnings.map(v => `- WARN ${v}`), ...(p.registration.errors.length || p.registration.warnings.length ? [] : ['无。']), '', '### 未解析项', '', ...p.unknown.map(v => `- ${JSON.stringify(v)}`));
  }
  lines.push('', '## 用户提供的疑似游戏问题（未验证）', '', ...report.userReportedSuspicions.map(v => `- ${v}`), '', '## 复跑', '', '```powershell', report.command, '```', '');
  return lines.join('\n');
}

function run(app) {
  return { schema: 'noname-skill-preflight/1', generatedAt: new Date().toISOString(), app: path.resolve(app), execution: 'registration-only; no game; no skill callbacks', limitations: [
    '执行实际 extension.js → precontent → 模块 → character/index 注册路径；使用最小引擎对象替身。官方 standard.js 仅移除 noname import，再运行实际 game.import 注册。注册错误与警告独立保留，零错误不等于动态技能正常。',
    '函数源码仅用正则识别写法。helper 外部函数、动态拼接技能 ID、条件注册及跨包技能定义可能未解析；JSON 保留 unknown 和缺失定义，不宣称完整静态程序分析。',
    'targets 可能是候选池；result.targets 才是明确选择结果线索。一次技能多次选择应分批保留顺序，不能合并成无序集合。',
    'direct content 进入后可能 chooseBool=false 退出，进入事件不能直接断言发动。mod-only 是持续规则，无需制造独立发动事件。logSkill/line 仅为信号。',
    '技能说明已给出的固定持续规则由 Agent 查阅技能理解，不要求重复写日志，也不计作日志缺口。公开标记层数、技能获得/失去等本局动态事实应与固定规则区分；私有 storage 不因预检而公开。',
    '当前实验日志主要记录公开动作、体力/上限/护甲/手牌数/装备判定区/濒死死亡；公开标记、扩展区、横置翻面等动态状态的表达仍不全。静态发现 damage 等调用不证明实际执行或精确因果。',
    '数组顺序保留；借刀等牌的有序复合目标和引擎事件回放应另外测试。本报告不自动推断 targets 的实际运行值。',
  ], userReportedSuspicions: ['nihil 包魔虚罗：用户报告“破魔不穿闪”，仅标记疑似游戏技能 bug；本轮没有验证现象或断言根因。', 'zus 包用户反馈存在多处 bug；forbidai 武将按要求排除，其余仍纳入，静态预检不为游戏逻辑背书。'], command: 'node scripts/skill-preflight.cjs --app "<游戏 resources/app>" --out "../research/skill-preflight-latest"', packs: [
    inventory(loadRegistration(app, 'nihilphile'), 'nihilphile'),
    inventory(loadRegistration(app, 'Zusfylri武将包'), 'zusfylri', { excludeForbidai: true }),
    inventory(loadRegistration(app, 'standard', true), 'official-standard', { select: ['guanyu', 'zhaoyun', 'diaochan', 'simayi'] }),
  ] };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || !args.length) { console.log('Offline registration-only skill inventory; does not start game or run skill callbacks.\nnode scripts/skill-preflight.cjs --app "<resources/app>" --out "../research/skill-preflight-latest"\nWrites .json and .md. Registration errors are preserved and cause exit code 2.'); }
  else {
    const app = args[args.indexOf('--app') + 1], output = args[args.indexOf('--out') + 1];
    if (!args.includes('--app') || !args.includes('--out') || !app || !output) throw new Error('--app and --out are required');
    const report = run(app); fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(`${output}.json`, JSON.stringify(report, null, 2) + '\n'); fs.writeFileSync(`${output}.md`, markdown(report));
    console.log(JSON.stringify({ output: path.resolve(output), packs: report.packs.map(p => ({ pack: p.pack, ...p.summary })) }, null, 2));
    if (report.packs.some(p => p.registration.errors.length || p.registration.warnings.length)) process.exitCode = 2;
  }
}
module.exports = { loadRegistration, classify, dependencies, inventory, markdown, run };

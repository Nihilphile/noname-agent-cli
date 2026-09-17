'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadRegistration, classify, dependencies, inventory, markdown } = require('../scripts/skill-preflight.cjs');

test('static classification distinguishes candidates, confirmation, late targets and optional activation', () => {
  const skill = { direct: true, async content(event, trigger, player) {
    event.targets = game.filterPlayer();
    event.target = result.targets[0];
    await player.chooseTarget();
    if (!(await player.chooseBool()).bool) return;
    player.logSkill('sample', event.target);
    event.target.damage();
  } };
  const got = classify(skill);
  assert.ok(got.styles.includes('async-await'));
  for (const pattern of ['chooseTarget', 'confirmed-result-targets', 'event-target-list-write-may-be-candidate-pool', 'late-singular-target-assignment']) assert.ok(got.targetPatterns.includes(pattern));
  assert.ok(got.risks.includes('content-entry-not-proof-of-activation'));
  assert.ok(got.risks.includes('candidate-pool-must-not-be-reported-as-selection'));
  assert.ok(got.statePatterns.includes('hp-maxhp'));
});

test('mod-only, legacy steps and unimplemented public-state kinds stay distinct', () => {
  assert.ok(classify({ mod: { targetInRange() { return true; } } }).styles.includes('mod-only-no-independent-activation'));
  const got = classify({ content() { 'step 0'; player.addMark('a', 1); 'step 1'; player.turnOver(); } });
  assert.ok(got.styles.includes('legacy-step'));
  assert.ok(got.statePatterns.includes('turnover-linked'));
  assert.ok(got.risks.includes('state-kind-outside-current-experimental-journal'));
});

test('literal dependency graph retains edge type and unresolved dynamic additions', () => {
  const got = dependencies('root', { group: ['first', 'second'], global: 'global_x', inherit: 'base', subSkill: { after: {} }, content() {
    player.addSkill('added'); player.addTempSkill(['temp_a', 'temp_b']);
    player.addAdditionalSkill('owner', 'given'); player.addSkill(event.skill);
  } });
  assert.deepEqual(got.edges.map(e => e.to), ['first', 'second', 'global_x', 'base', 'root_after', 'added', 'temp_a', 'temp_b', 'given']);
  assert.equal(got.unknown.length, 1);
  assert.equal(got.unknown[0].expression, 'event.skill');
});

test('comments do not create false target patterns, dependencies, or helper unknowns', () => {
  const skill = { content() {
    // player.chooseTarget(); event.target = result.targets[0]; player.addSkill('fake');
    player.draw();
  } };
  assert.deepEqual(classify(skill).targetPatterns, []);
  assert.deepEqual(classify(skill).unresolvedHelperCalls, []);
  assert.deepEqual(dependencies('root', skill).edges, []);
});

function sampleLoaded() {
  return { packs: [{ character: { good: ['male', 'wei', 4, ['root']], disabled: ['male', 'wei', 4, ['bad'], ['forbidai']] }, skill: {
    root: { group: 'root_after', subSkill: { after: { global: 'external' } } },
    bad: { content() {} }, bad_hidden: { content() {} }, helper: { content() {} },
  }, translate: {} }], files: [], errors: [], warnings: [], forbidai: [], skillOwners: { root: ['good'], helper: ['good'], bad: ['disabled'], bad_hidden: ['disabled'] } };
}
test('forbidai exclusions skip their unlinked module helpers; missing external definitions remain unknown', () => {
  const got = inventory(sampleLoaded(), 'test', { excludeForbidai: true });
  assert.equal(got.included.length, 1); assert.equal(got.excluded.length, 1);
  assert.deepEqual(got.included[0].skills, ['root', 'root_after', 'external']);
  assert.equal(got.summary.unresolvedSkills, 1);
  assert.deepEqual(got.auxiliarySkills.map(s => s.id), ['helper']);
  assert.ok(got.unknown.some(v => v.kind === 'registered-skill-without-resolved-owner'));
});
test('nihil policy includes forbidai and explicit official selection reports absent requested ids', () => {
  assert.equal(inventory(sampleLoaded(), 'nihil').included.length, 2);
  const got = inventory(sampleLoaded(), 'official', { select: ['good', 'missing'] });
  assert.equal(got.included.length, 1); assert.equal(got.auxiliarySkills.length, 0);
  assert.ok(got.unknown.some(v => v.kind === 'requested-official-character-missing'));
});

test('a dependency shared with an excluded character remains included for a permitted character', () => {
  const loaded = sampleLoaded();
  loaded.packs[0].skill.root.group = ['root_after', 'bad'];
  const got = inventory(loaded, 'test', { excludeForbidai: true });
  assert.ok(got.included[0].skills.includes('bad'));
  assert.ok(got.skills.some(s => s.id === 'bad'));
  assert.ok(!got.auxiliarySkills.some(s => s.id === 'bad_hidden'));
  assert.equal(got.rootAssessments.length, 1);
  assert.match(got.rootAssessments[0].status, /runtime-unverified/);
});

test('actual registration callbacks load modules without executing any skill callbacks', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noname-preflight-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ext = path.join(root, 'extension', 'fixture'); fs.mkdirSync(path.join(ext, 'module'), { recursive: true });
  fs.writeFileSync(path.join(ext, 'extension.js'), `game.import('extension', function(lib) { return { precontent: function() { lib.init.jsSync(lib.assetURL+'extension/fixture/module', 'main'); } }; });`);
  fs.writeFileSync(path.join(ext, 'module', 'main.js'), `game.import('character', function() { return { character: {hero:['male','wei',4,['root']]}, skill: { root: { content: function() { throw new Error('CONTENT MUST NOT RUN'); }, filter: function() { throw new Error('FILTER MUST NOT RUN'); } } } }; });`);
  const got = loadRegistration(root, 'fixture');
  assert.equal(got.errors.length, 0); assert.equal(got.packs.length, 1);
  assert.equal(got.files.length, 2); assert.match(got.files[0].sha256, /^[0-9a-f]{64}$/);
  const inspected = inventory(got, 'fixture');
  assert.equal(inspected.summary.reachableSkills, 1);
  assert.equal(inspected.rootAssessments[0].source.file, 'extension/fixture/module/main.js');
  assert.equal(inspected.rootAssessments[0].source.line, 1);
});

test('failed registration is explicit evidence and cannot masquerade as an empty success', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noname-preflight-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const got = loadRegistration(root, 'missing');
  assert.ok(got.errors.length >= 1); assert.equal(got.packs.length, 0);
});

test('markdown labels static scope and auxiliary unknowns without a dynamic pass percentage', () => {
  const report = { generatedAt: 'test', limitations: ['不调用技能'], packs: [inventory(sampleLoaded(), 'fixture')], userReportedSuspicions: ['仅为用户报告，未验证'], command: 'node scripts/skill-preflight.cjs --help' };
  const text = markdown(report);
  assert.match(text, /不是实际发动覆盖率或动态通过率/);
  assert.match(text, /归属未解析/);
  assert.match(text, /未验证/);
});

test('fixed mod-only rules require skill descriptions, not fabricated activation logs or a runtime log failure', () => {
  const skill = { mod: { globalFrom() { return -1; } } };
  assert.equal(classify(skill).logExpectation, 'read-skill-description-no-activation-log');
  const loaded = sampleLoaded();
  loaded.packs[0].skill.root = skill;
  const got = inventory(loaded, 'fixture', { select: ['good'] });
  assert.equal(got.rootAssessments[0].status, 'static-rule-description-no-activation-log-required');
});

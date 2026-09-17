'use strict';
// Offline presentation probes. These exercise the actual collector/formatter,
// not character content or a complete engine/game. No installed game required.
const { createEventJournal } = require('../src/event-journal.cjs');
const { formatExperimental } = require('../src/experimental-format.cjs');
function fixture() {
  const players = ['甲', '乙', '丙'].map((name, i) => ({ name, id: `p${i + 1}`, hp: 3, maxHp: 3, hujia: 0, hand: 4, countCards() { return this.hand; }, getCards() { return []; } }));
  const [a, b, c] = players;
  const deps = { game: { players, dead: [], me: a }, lib: { skill: { shield: { direct: true }, distribute: { forced: true } }, card: { jiedao: { singleCard: true } }, translate: { shield: '加盾', distribute: '分配', jiedao: '借刀杀人' } }, get: {}, _status: { dying: [] }, playerId: p => p.id, canonicalSkill: n => n };
  return { a, b, c, journal: createEventJournal(deps) };
}
const probes = [
  ['借刀：已拆分的主目标与附加目标', f => {
    f.journal.begin({ name: 'useCard', player: f.a, card: { name: 'jiedao' }, targets: [f.c], _targets: [f.c, f.b], addedTargets: [f.b] });
  }],
  ['执行中指定目标，明确确认后增加护甲', f => {
    const event = { name: 'shield', player: f.a }; f.journal.begin(event);
    event.target = f.b;
    f.journal.confirmSkill({ player: f.a, skill: 'shield', targets: f.b, event });
    f.b.hujia++; f.journal.sample(event); f.journal.finish(event);
  }],
  ['多批目标选择，候选池不冒充已选目标', f => {
    const event = { name: 'distribute', player: f.a }; f.journal.begin(event);
    event.targets = [f.a, f.b, f.c];
    f.journal.finish({ name: 'chooseTarget', player: f.a, parent: event, result: { bool: true, targets: [f.c] } });
    f.a.hand--; f.c.hand++; f.journal.sample(event);
    f.journal.finish({ name: 'chooseTarget', player: f.a, parent: event, result: { bool: true, targets: [f.b] } });
    f.b.hp--; f.journal.sample(event);
  }],
  ['可选技能取消：不输出发动', f => {
    const event = { name: 'shield', player: f.a }; f.journal.begin(event); event.target = f.b;
    f.journal.finish({ name: 'chooseBool', player: f.a, parent: event, result: { bool: false } });
    f.journal.finish(event);
  }],
];
function run() {
  return { scope: 'synthetic presentation probes; not character execution or game acceptance', probes: probes.map(([name, execute]) => {
    const f = fixture(); execute(f); const log = f.journal.logs();
    return { name, log, text: formatExperimental(log) };
  }) };
}
if (require.main === module) {
  const value = run();
  console.log(process.argv.includes('--json') ? JSON.stringify(value, null, 2) : value.probes.map(p => `## ${p.name}\n\n${p.text}`).join('\n\n'));
}
module.exports = { run };

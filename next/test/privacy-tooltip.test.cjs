'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { installPage } = require('../src/page.cjs');

class Element {
  constructor(classes = '', text = '') { this.classes = new Set(classes.split(' ').filter(Boolean)); this.children = []; this.ownText = text; this.isConnected = true; this.classList = { contains: value => this.classes.has(value) }; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.ownText = value; this.children = []; }
  get innerText() { return this.textContent; }
  set innerHTML(value) { this.textContent = String(value).replace(/<[^>]+>/g, ''); }
  closest() { return null; }
  getClientRects() { return [{}]; }
  querySelectorAll(selector) { const classes = selector.split('.').filter(Boolean); return this.children.flatMap(child => [...(classes.every(name => child.classes.has(name)) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  remove() { this.isConnected = false; }
}
function fixture(nested = false) {
  const player = (name, identity) => Object.assign(new Element('player'), { name, identity, hp: 3, maxHp: 3, marks: {}, countCards: () => 0, countMark: () => 1, getCards: () => [], getSkills: () => [], getExpansions: () => [], isDead: () => false, isLinked: () => false, isTurnedOver: () => false });
  const me = player('self', 'fan'), other = player('other', 'nei');
  other.marks.private_pile = new Element('mark', '1');
  const tooltip = () => {
    const root = new Element('', '共有一张扣置牌：');
    if (nested) {
      const button = new Element('button card'); button.children.push(new Element('infohidden', 'secret_other_hand')); root.children.push(button);
    } else root.children.push(new Element('button card infohidden', 'secret_other_hand'));
    return root;
  };
  const args = { lib: { skill: {}, card: {}, translate: {} }, game: { me, players: [me, other], dead: [], over() {} }, ui: { dialogs: [] }, get: { mode: () => 'identity', nodeintro: tooltip }, _status: { imchoosing: false, event: null } };
  const context = vm.createContext({ window: {}, document: { createElement: () => new Element(), querySelectorAll: () => [] }, getComputedStyle: () => ({ visibility: 'visible' }) });
  const api = vm.runInContext(`(${installPage.toString()})`, context)(args);
  return { api, args, other, me };
}

for (const nested of [false, true]) test(`tooltip hidden card ${nested ? 'descendant' : 'root'} text is absent from entire observe and inspect responses`, () => {
  const { api } = fixture(nested);
  const observed = api.observe(true);
  const inspected = api.inspect({ id: observed.players[0].id });
  for (const output of [observed, inspected]) {
    assert.equal(JSON.stringify(output).includes('secret_other_hand'), false);
    const marks = output.marks || output.players[0].marks;
    assert.match(marks[0].description, /共有一张扣置牌/);
    assert.match(marks[0].description, /暗牌/);
    assert.ok(marks[0].cards.every(card=>card.visibility==='hidden')); 
  }
});

test('opponent and global skill descriptions use static public rules without evaluating private dynamic state', () => {
  const {api,args,other,me}=fixture();
  args.lib.skill.public_rule={}; args.lib.translate.public_rule='公开技能'; args.lib.translate.public_rule_info='公开说明';
  args.lib.skill.global_rule={}; args.lib.translate.global_rule='全场技能'; args.lib.translate.global_rule_info='静态全场说明';
  args.lib.skill.global=['global_rule']; args.lib.skill.globalmap={global_rule:[other]};
  other.getSkills=()=>['public_rule'];
  const called=[]; args.get.skillInfoTranslation=(name,p)=>{called.push(p);return 'secret_other_storage';};
  const output=api.observe(true);
  assert.equal(called.includes(other),false);
  assert.equal(JSON.stringify(output).includes('secret_other_storage'),false);
  assert.equal(output.players[0].skills[0].description,'公开说明');
  assert.equal(output.me.globalSkills[0].description,'静态全场说明');
  other.classes.add('unseen');
  assert.equal(api.observe(true).me.globalSkills.length,0);
});

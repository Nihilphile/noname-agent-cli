'use strict';

const CARD_NAMES = Object.freeze({
  sha: ['杀'], shan: ['闪'], tao: ['桃'], jiu: ['酒'],
  lebu: ['乐不思蜀', '乐'], bingliang: ['兵粮寸断', '兵'], shunshou: ['顺手牵羊', '顺'], guohe: ['过河拆桥', '拆'],
  wuzhong: ['无中生有', '无中'], wuxie: ['无懈可击', '无懈'], nanman: ['南蛮入侵', '南'], wanjian: ['万箭齐发', '万'],
  taoyuan: ['桃园结义', '桃园'], wugu: ['五谷丰登', '五'], tiesuo: ['铁索连环', '铁索'], jiedao: ['借刀杀人', '借'], juedou: ['决斗', '决'],
  huogong: ['火攻'], zhuge: ['诸葛连弩'],
});
const ABBREVIATIONS = Object.freeze(Object.fromEntries(Object.values(CARD_NAMES).filter(names => names.length > 1).map(names => [names[0], names[1]])));
const aliases = new Map(Object.entries(CARD_NAMES).flatMap(([id, names]) => [id, ...names].map(name => [name, id])));
const suits = new Map([['♠', 'spade'], ['黑桃', 'spade'], ['spade', 'spade'], ['♥', 'heart'], ['红桃', 'heart'], ['heart', 'heart'], ['♣', 'club'], ['梅花', 'club'], ['club', 'club'], ['♦', 'diamond'], ['方片', 'diamond'], ['diamond', 'diamond']]);
const numbers = new Map([['A', 1], ['J', 11], ['Q', 12], ['K', 13]]);
const invalid = message => Object.assign(new Error(message), { code: 'invalid_play' });

// Split only at the requested nesting level. Angle brackets are card objects,
// while a top-level > remains the existing sequential operator.
function split(text, separators) {
  const pairs = { '(': ')', '[': ']', '【': '】', '<': '>', '‹': '›' }, closing = new Set(Object.values(pairs));
  const stack = [], parts = [], operators = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!stack.length && separators.includes(c)) {
      parts.push(text.slice(start, i).trim()); operators.push(c); start = i + 1;
    } else if (pairs[c]) stack.push(pairs[c]);
    else if (closing.has(c)) { if (stack.pop() !== c) throw invalid('操作串括号不匹配。'); }
  }
  if (stack.length) throw invalid('操作串括号不匹配。');
  parts.push(text.slice(start).trim());
  if (parts.some(part => !part)) throw invalid('分隔符两侧都需要操作或对象。');
  return { parts, operators };
}
function parseFace(value) {
  const input = value.trim().replace(/[\uFE0E\uFE0F]/g, '');
  if (!input) return null;
  if (input.startsWith('id:')) {
    const id = input.slice(3);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw invalid('实体 ID 格式无效。');
    return { id };
  }
  let suit, rest = input;
  for (const [key, canonical] of suits) if (rest.toLowerCase().startsWith(key)) { suit = canonical; rest = rest.slice(key.length).trim(); break; }
  const number = rest ? numbers.get(rest.toUpperCase()) ?? (/^(?:[1-9]|1[0-3])$/.test(rest) ? Number(rest) : NaN) : undefined;
  if (number !== undefined && !Number.isFinite(number) || !suit && number === undefined) throw invalid(`牌面条件无效：${value}`);
  return { ...(suit ? { suit } : {}), ...(number !== undefined ? { number } : {}) };
}
function cardSelector(text) {
  const match = /^([^【】]*)?(?:【([^】]*)】)?$/.exec(text.trim());
  if (!match) throw invalid(`卡牌对象无效：${text}`);
  const selector = (match[1] || '').trim(), face = match[2] == null ? null : parseFace(match[2]);
  if ((!selector && !face) || /[\s()[\]<>‹›{};|,，]/.test(selector)) throw invalid(`卡牌对象无效：${text}`);
  const nature = ({ 火杀: 'fire', 雷杀: 'thunder', 冰杀: 'ice', 普通杀: '' })[selector];
  return { selector, name: nature !== undefined ? 'sha' : aliases.get(selector) || selector, face, ...(nature !== undefined ? { nature } : {}), ...(selector === '任意' ? { any: true } : {}) };
}
function objectList(text) { return split(text, ',，、').parts.map(cardSelector); }
function rawStep(raw) {
  const match = /^act\(([^)]*)\)(?:\s+(.*))?$/.exec(raw);
  if (!match) return null;
  const words = `${match[1]} ${match[2] || ''}`.trim().split(/\s+/).filter(Boolean), id = words.shift();
  if (!id || /[()[\]【】<>|]/.test(id)) throw invalid('原始操作缺少有效 ID。');
  const request = { id };
  while (words.length) {
    const flag = words.shift(), key = ({ '--unselect': 'unselect', '--value': 'value', '--to': 'to' })[flag];
    if (!key || Object.hasOwn(request, key)) throw invalid(`无效或重复参数：${flag}`);
    if (key === 'unselect') request[key] = true;
    else { if (!words.length || words[0].startsWith('--')) throw invalid(`${flag} 需要一个值。`); request[key] = words.shift(); }
  }
  return { kind: 'act', raw, request };
}
function parseStep(raw) {
  const action = rawStep(raw);
  if (action) return action;
  if (['confirm', 'cancel', '确认', '取消'].includes(raw)) return { kind: 'act', raw, request: { id: ['confirm', '确认'].includes(raw) ? 'confirm' : 'cancel' } };
  if (raw === '结束出牌') return { kind: 'end', raw };
  const selection = /^(选择|弃置|展示)[<‹](.*)[>›]$/.exec(raw);
  if (selection) return { kind: 'select', raw, verb: selection[1], objects: objectList(selection[2]) };
  const responding = raw.startsWith('打出'), input = responding ? raw.slice(2).trim() : raw;
  const open = input.indexOf('[');
  if (open !== -1 && !input.endsWith(']')) throw invalid(`目标列表无效：${raw}`);
  const selector = cardSelector(open === -1 ? input : input.slice(0, open));
  if (selector.any) throw invalid('完整用牌需要牌种或实体身份。');
  const body = open === -1 ? null : input.slice(open + 1, -1).trim();
  const specs = body ? split(body, ',，').parts.map(target => {
    const match = /^([^<‹]*)(?:[<‹](.*)[>›])?$/.exec(target);
    if (!match || /[\s()[\]【】<>‹›{};|]/.test(match[1])) throw invalid(`目标无效：${target}`);
    if (match[2] == null && !match[1]) throw invalid('目标缺失。');
    return { target: match[1] || null, ...(match[2] != null ? { objects: objectList(match[2]) } : {}) };
  }) : [];
  if (specs.filter(spec => spec.objects).length > 1 || specs.some(spec => spec.objects) && specs.length !== 1) throw invalid('后续卡牌对象目前用于单角色目标。');
  return { kind: 'card', raw, ...selector, targets: specs.map(spec => spec.target).filter(Boolean),
    ...(responding ? { respond: true } : {}), ...(body === '' ? { randomTarget: true } : {}),
    ...(specs.some(spec => spec.objects) ? { objectTarget: specs[0] } : {}) };
}
function parsePlay(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 65536) throw invalid('play 需要非空且不超过 64 KiB 的文本。');
  const { parts, operators } = split(text.trim(), '>|');
  if (parts.length > 256) throw invalid('play 最多包含 256 项操作。');
  const groups = [[]];
  parts.forEach((part, i) => { groups.at(-1).push(parseStep(part)); if (operators[i] === '|') groups.push([]); });
  return { kind: 'play-plan', source: text.trim(), groups };
}
function matchesCard(card, spec) {
  if (!card || card.visibility === 'hidden') return !!spec.any && !spec.face && spec.nature === undefined;
  if (spec.face?.id && card.id !== spec.face.id) return false;
  if (!spec.any && spec.selector && card.id !== spec.selector && card.name !== spec.name && card.label !== spec.selector) return false;
  const nature = Array.isArray(card.nature) ? card.nature.join('|') : card.nature || '';
  if (spec.nature !== undefined && spec.nature !== nature) return false;
  return (!spec.face?.suit || card.suit === spec.face.suit) && (spec.face?.number == null || card.number === spec.face.number);
}
function formatCard(card) {
  const name = card?.label || card?.name || '?', suit = ({ spade: '♠', heart: '♥', club: '♣', diamond: '♦' })[card?.suit];
  return (ABBREVIATIONS[name] || name) + (suit && Number.isFinite(card?.number) ? `【${suit}${card.number}】` : '');
}
module.exports = { ABBREVIATIONS, parsePlay, matchesCard, formatCard, cardSelector };

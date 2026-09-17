'use strict';

// Presentation only. Never mutate journal entries, infer outcomes, reorder by
// actor, collapse repetitions, or replace names inside an unrecognised line.
const CARD_NAMES = Object.freeze({
  乐不思蜀: '乐', 兵粮寸断: '兵', 顺手牵羊: '顺', 过河拆桥: '拆',
  无中生有: '无中', 无懈可击: '无懈', 南蛮入侵: '南', 万箭齐发: '万',
  桃园结义: '桃园', 五谷丰登: '五', 铁索连环: '铁', 借刀杀人: '借', 决斗: '决',
});
const COUNT = '[零〇一二两三四五六七八九十百千万0-9]+';
const PLAIN_CARDS = new Set([...Object.keys(CARD_NAMES), '杀', '火杀', '雷杀', '冰杀', '闪', '桃', '酒', '火攻', '决斗']);
function amount(value) {
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (Object.hasOwn(digits, value)) return digits[value];
  const tens = /^([一二两三四五六七八九]?)十([一二三四五六七八九]?)$/.exec(value);
  return tens ? (tens[1] ? digits[tens[1]] : 1) * 10 + (tens[2] ? digits[tens[2]] : 0) : value;
}

function cardList(value) {
  const result = [];
  for (const item of value.split('、')) {
    let match = /^([^\s【】：，、。；,;]{1,40})(【[♠♥♣♦][\uFE0E\uFE0F]?(?:10|[A1-9JQK])】)?$/.exec(item);
    if (match && (match[2] || PLAIN_CARDS.has(match[1]))) { result.push((CARD_NAMES[match[1]] || match[1]) + (match[2] || '')); continue; }
    match = /^【([^\s【】：，、。；,;]{1,40})】$/.exec(item);
    if (match) { result.push(`【${CARD_NAMES[match[1]] || match[1]}】`); continue; }
    return null;
  }
  return result.join('、');
}

function compactBody(body) {
  if (body === '的回合开始') return '回合开始';
  let match = /^进入了(准备|判定|摸牌|出牌|弃牌|结束)阶段$/.exec(body);
  if (match) return match[1] + '阶段';
  match = new RegExp(`^摸了(${COUNT})张牌$`).exec(body);
  if (match) return '摸' + amount(match[1]);
  match = new RegExp(`^受到了来自([^：:，,；;。\\s]+)的(${COUNT})点(.*?)伤害$`).exec(body);
  if (match && ['', '火焰', '雷电', '冰', '神'].includes(match[3])) return `受${match[3]}伤${amount(match[2])}←${match[1]}`;
  match = new RegExp(`^受到了(${COUNT})点(.*?)伤害$`).exec(body);
  if (match && ['', '火焰', '雷电', '冰', '神'].includes(match[2])) return `受${match[2]}伤${amount(match[1])}`;
  match = new RegExp(`^(失去|回复)了(${COUNT})点体力$`).exec(body);
  if (match) return `hp${match[1] === '失去' ? '-' : '+'}${amount(match[2])}`;
  match = new RegExp(`^(减少|增加)了(${COUNT})点体力上限$`).exec(body);
  if (match) return `上限${match[1] === '减少' ? '-' : '+'}${amount(match[2])}`;
  if (['濒死', '死亡', '阵亡', '的回合结束'].includes(body)) return body === '的回合结束' ? '回合结束' : body;
  match = /^被([^：:，,；;。\s]+)杀害$/.exec(body);
  if (match) return body;
  // Skill syntax is intentionally separate: a skill may share a card's name.
  match = /^(对([^：:，,；;。\s]+))?发动了(【[^【】]+】)$/.exec(body);
  if (match) return `发动${match[3]}${match[2] ? '→' + match[2] : ''}`;
  match = /^(对([^：:，,；;。\s]+))?使用了(.+)$/.exec(body);
  if (match) { const cards = cardList(match[3]); if (cards !== null) return `用${cards}${match[2] ? '→' + match[2] : ''}`; }
  match = /^(打出|装备|弃置|展示|失去)了(.+)$/.exec(body);
  if (match) { const cards = cardList(match[2]); if (cards !== null) return match[1] + cards; }
  match = /^被贴上了(.+)$/.exec(body);
  if (match) { const cards = cardList(match[1]); if (cards !== null) return '被贴' + cards; }
  match = /^从([^：:，,；;。\s]+)获得了(.+)$/.exec(body);
  if (match) { const cards = cardList(match[2]); if (cards !== null) return `从${match[1]}获得${cards}`; }
  match = /^进行([^【】：，,；;。\s]+)判定，亮出的判定牌为(.+)$/.exec(body);
  if (match) { const cards = cardList(match[2]); if (cards !== null) return `${CARD_NAMES[match[1]] || match[1]}判定：${cards}`; }
  match = /^的判定结果为(.+)$/.exec(body);
  if (match) { const cards = cardList(match[1]); if (cards !== null) return '判定结果：' + cards; }
  return null;
}

function parseLine(value, actors) {
  if (typeof value !== 'string') return null;
  // With known public labels never split a name at a verb-like character.
  if (actors.length) {
    const matching = actors.filter(actor => value.startsWith(actor));
    if (matching.length !== 1) return null;
    const actor = matching[0], body = compactBody(value.slice(actor.length));
    return body === null ? null : { actor, body };
  }
  // Without known public names, a line such as "甲未死亡" could be parsed as
  // actor="甲未", action="死亡". No finite negation list makes that safe.
  return null;
}

function formatLogs(log, { raw = false, actors = [] } = {}) {
  const entries = Array.isArray(log?.entries) ? log.entries : [];
  const from = log?.from ?? entries[0]?.seq ?? 0, to = log?.to ?? entries.at(-1)?.seq ?? 0;
  const lines = [`战报 ${log?.epoch ?? '未知'}\n${entries.length ? '[' + from + '-' + to + ']' : '[无新增日志]'}${log?.truncated ? '（记录已截断）' : ''}`];
  if (raw) return lines.concat(entries.map(entry => `[${entry.seq}] ${entry.text}`)).join('\n');
  const names = actors.filter(name => typeof name === 'string' && name).sort((a, b) => b.length - a.length);
  const duplicates = new Set(names.filter((name, index) => names.indexOf(name) !== index));
  let pending = null;
  const flush = () => {
    if (!pending) return;
    lines.push(`[${pending.from === pending.to ? pending.from : pending.from + '-' + pending.to}] ${pending.actor}：${pending.bodies.join('；')}`);
    pending = null;
  };
  for (const entry of entries) {
    const parsed = parseLine(entry.text, names);
    if (!parsed || duplicates.has(parsed.actor)) { flush(); lines.push(`[${entry.seq}] ${entry.text}`); continue; }
    if (pending?.actor === parsed.actor && Number.isSafeInteger(entry.seq) && entry.seq === pending.to + 1) {
      pending.to = entry.seq; pending.bodies.push(parsed.body);
    } else { flush(); pending = { actor: parsed.actor, from: entry.seq, to: entry.seq, bodies: [parsed.body] }; }
  }
  flush();
  return lines.join('\n');
}

module.exports = { formatLogs };

'use strict';
const { ENTRY_READY_EXPRESSION } = require('./native-bootstrap.cjs');

// Serialized into the renderer. This reads definitions, never players or
// dynamicTranslate: inspecting a catalogue entry must not reveal live state.
function lookupCharacter({ lib, get }, id) {
  const own = (object, key) => !!object && Object.prototype.hasOwnProperty.call(object, key);
  const fail = (code, message) => ({ error: { code, message } });
  if (typeof id !== 'string' || !id || id.trim() !== id) return fail('invalid_character', 'Provide an exact, non-empty character ID.');
  const packs = lib.characterPack || {};
  const packNames = Object.keys(packs).filter(pack => own(packs[pack], id));
  const enabled = own(lib.character, id) && !!lib.character[id];
  const raw = enabled ? lib.character[id] : packNames.length ? packs[packNames[0]][id] : null;
  if (!raw) return fail('character_not_found', `Character ${id} is not in the loaded catalogue; use characters to discover exact IDs.`);
  const clean = value => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() : '';
  const label = key => clean(lib.translate?.[key]) || key;
  const strings = value => (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).filter(x => typeof x === 'string');
  const array = Array.isArray(raw), tags = array ? strings(raw[4]) : [];
  const flag = (field, tag) => array ? tags.includes(tag) : !!raw[field];
  // Mirror Character's legacy tuple conversion, using engine helpers when present.
  const parseHp = (value, part) => {
    if (typeof value === 'number') return part === 2 ? 0 : value;
    if (typeof value !== 'string') return 0;
    const piece = value.includes('/') ? value.split('/')[part] : part < 2 && ['Infinity', '∞'].includes(value) ? value : '';
    return ['Infinity', '∞'].includes(piece) ? Infinity : piece ? parseInt(piece, 10) : 0;
  };
  const number = value => value === Infinity ? 'Infinity' : value === -Infinity ? '-Infinity' : Number.isFinite(value) ? value : null;
  const hp = array ? (get.infoHp ? get.infoHp(raw[2]) : parseHp(raw[2], 0)) : raw.hp;
  const maxHp = array ? (get.infoMaxHp ? get.infoMaxHp(raw[2]) : parseHp(raw[2], 1)) : typeof raw.maxHp === 'number' ? raw.maxHp : hp;
  const armor = array ? (get.infoHujia ? get.infoHujia(raw[2]) : parseHp(raw[2], 2)) : raw.hujia ?? 0;
  const mode = get.mode();
  let reason = null;
  if (!enabled) reason = 'pack_not_enabled';
  else if (lib.config?.banned?.includes(id)) reason = 'banned_in_current_mode';
  else if (typeof lib.characterFilter?.[id] === 'function') {
    try { if (!lib.characterFilter[id](mode)) reason = 'restricted_in_current_mode'; }
    catch { reason = 'availability_check_failed'; }
  }
  if (!reason && (flag('isMinskin', 'minskin') || flag('isUnseen', 'unseen') || flag('isHiddenInStoneMode', 'stonehidden') || ((flag('isBoss', 'boss') || flag('isHiddenBoss', 'hiddenboss')) && !flag('isBossAllowed', 'bossallowed')))) reason = 'not_offered_by_free_choice';
  const skills = [...new Set(strings(array ? raw[3] : raw.skills))].map(skillId => {
    const definition = lib.skill?.[skillId] || {};
    let descriptionId = skillId, description = clean(lib.translate?.[skillId + '_info']);
    const seen = new Set([skillId]);
    // A generated subskill can inherit its published source rule. Never execute
    // callbacks or infer current ownership from group/sourceSkill relationships.
    while (!description && seen.size < 32) {
      const source = lib.skill?.[descriptionId]?.sourceSkill;
      if (typeof source !== 'string' || seen.has(source)) break;
      seen.add(source); descriptionId = source;
      description = clean(lib.translate?.[source + '_info']);
    }
    return { id: skillId, name: label(skillId), description: description || null, descriptionSource: description ? 'static_public_rule' : 'unavailable', descriptionSkill: description ? descriptionId : null, sourceSkill: typeof definition.sourceSkill === 'string' ? definition.sourceSkill : null, group: strings(definition.group) };
  });
  return { mode, scope: 'static_public_catalog', character: {
    id, name: label(id), sex: (array ? raw[0] : raw.sex) ?? null, group: (array ? raw[1] : raw.group) ?? null,
    hp: number(hp), maxHp: number(maxHp), armor: number(armor), packs: packNames,
    available: !reason, reason, aiAllowed: !flag('isAiForbidden', 'forbidai') && !lib.config?.forbidai?.includes(id), skills,
  }, notes: ['这是武将原始资料；本局临时获得的技能和公开标记请用 inspect PLAYER skills 查看。', '技能关联关系不表示该角色在本局已获得这些关联技能。'] };
}

async function character(cdp, id, { native = false } = {}) {
  const guard = native ? `if(!(${ENTRY_READY_EXPRESSION}))throw new Error('native_entry_not_ready: waiting for index document and import map');` : '';
  const result = await cdp.evaluate(`(async()=>{${guard}const {lib,get}=await import('/noname.js');return (${lookupCharacter.toString()})({lib,get},${JSON.stringify(id ?? null)});})()`);
  if (result?.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result;
}

module.exports = { character, lookupCharacter };

#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const nativeSession = require('../src/native-session.cjs');
const isolatedSession = require('../src/session.cjs');
const nativeSetup = require('../src/native-setup.cjs');
const isolatedSetup = require('../src/setup.cjs');
const {parsePlan,validatePlan,executePlan} = require('../src/plan.cjs');
const {parsePlay,executePlay} = require('../src/play.cjs');
const { waitAfterAction, waitText } = require('../src/act-wait.cjs');
const page = require('../src/page.cjs');
const notifications = require('../src/notification.cjs');
const { formatLogs } = require('../src/log-format.cjs');
const displayConfig = require('../src/display-config.cjs');
const displayFeedback = require('../src/display-feedback.cjs');
const { formatExperimental } = require('../src/experimental-format.cjs');
const contentProfiles = require('../src/content-profile.cjs');
const HELP = `noname-agent — 外部 Agent 游戏工具

node bin/noname.cjs <command> [options]

doctor                 检查 Node、游戏源码与浏览器
setup --source PATH   一次性保存本机游戏目录（安装目录或 resources/app）
                       可选 --executable EXE、--browser EXE；配置只保存在本机
extension import ZIP --target room|native [--replace] [--reload] [--session NAME]
extension list  查看供新房间使用的扩展；原客户端默认导入后手动重载
extension reports | extension report ID  查看持久错误报告
extension watch on|off|status --session NAME [--client native|isolated]
                       新会话自动后台监听局内错误；旧会话可手动开启
extension import ... --observe-seconds 3  重载后继续观察延迟错误（0..30秒）
room create NAME [--mode doudizhu|2v2] [--host human|agent] [--session HOST] [--turn-seconds 600]
                       创建独立本地房间；人类房主默认打开游戏窗口
                       可选 --extensions 名称列表 --character-packs ID列表 --card-packs ID列表
room join NAME --session PLAYER [--visible]  独立 Agent 客户端入房
room start|status|close NAME  开局、查看成员或结束整个房间
room leave NAME --session PLAYER  客机离开；房主离开需明确 close
start --mode identity|doudizhu|2v2 --character ID   启动原客户端（可见窗口）并定向选将
characters [QUERY]     查询当前环境武将（须先 start）
character ID           单独查看精确武将ID的公开基础资料和原生技能说明
observe [--detail]     当前选择、自己手牌、公开局面；detail含技能/标记
receipt [ID]          本地读取最近或指定 play 收据，连接中断后也可查
act OPTION --at REV [--unselect]  点击当前选择中的id（或confirm/cancel）
act BUTTON --to GROUP_OR_BUTTON --at REV  移动牌/交换位置
act NUMBER --value VALUE --at REV  设置数量下拉框
act CARD TARGET confirm --at REV   组合提交明确动作；遇新选择立即停止
act ... --at REV --wait [--wait-seconds 15]  动作成功后等待选择/死亡/结局，等待1..60秒
                      --seconds 仍只控制计划执行时限；等待结束可另用最多1秒确认快照
wait [--seconds 15]    等待自己选择、死亡或结局，最多60秒
notify on [--detail] [--thread UUID]  订阅新决策；默认简短通知，detail附场面和日志
notify off|status      停止通知或检查后台与投递状态
inspect PLAYER skills  查看指定角色当前公开技能和标记
logs [--from N]         查看所选日志模式的战报（不消耗 act 增量）
watch on|off|status    后台记录人类游玩的实验战报；on 可打开原客户端，自行选将开局
logs --all            查看最近一局已归档的实验战报，关窗后仍可读
logs games            列出本会话历史对局；--game ID 读指定局
logs --game ID [--round N] [--from N --to N]   按轮次或事件序号筛选
effects [--limit 10]   最近用牌/技能的已观测结算效果
act "a > b > 技能ID:cancel" --at REV  有归属检查的串联
act --stdin --at REV   从标准输入读取组合字符串或 JSON 有限条件计划
play "CARD[TARGET] > act(ID) | CARD" --at REV   执行有限混合操作串
                      杀【♥12】[角色]、杀【id:c123】[]、拆[角色<诸葛连弩>]
                      选择<桃>、弃置<闪,杀>、展示<闪>、打出杀、结束出牌、confirm/cancel
play --stdin --at REV [--seconds 30] [--interval-ms 500]
                      整串限时1..60秒；每次底层动作间隔0..5000毫秒
play ... --at REV --wait [--wait-seconds 15]  整串成功后另等选择/死亡/结局，等待1..60秒
rule ID               技能/卡牌说明
history [--limit 20]   最近操作与结果证据
restart [--mode MODE] [--character ID]  记录本次参与并重开，默认保留任务
status                检查会话连接
diagnose              客户端连接及可见弹窗
config                查看本工具目录的显示配置
config set logs classic|compact|experimental   经典、压缩、事件流实验模式
config set state auto|show|hide  auto默认：每个出牌阶段首次反馈显示全场，之后隐藏
config reset          恢复显示默认值，不改游戏配置
stop                  关闭自己创建的客户端、清理临时配置，保留证据

通用: --session NAME (默认default), --json (结构化数据), --raw|--compact
显示覆盖: --state_auto|--state_hide|--state_show；保留revision、选择、结果和战报
日志覆盖: --log-mode classic|compact|experimental；--raw等同classic
start/doctor: --source 游戏resources/app绝对路径, --browser 浏览器exe路径
start: --client native|isolated (默认 native), --port 9222, --attach
isolated start/restart: 可选 --extensions 名称列表 --character-packs ID列表 --card-packs ID列表
start: --notify codex-desktop [--notify-thread UUID]；notify on 可用 --desktop-executable PATH
native 使用原配置；isolated 显式启用旧版隔离环境，--visible 可显示隔离窗口
详见 README.md。无需 npm install；不调用模型，不代替你作出游戏决策。`;

function parse(argv) {
  const options = {}, positional = [];
  const bools = new Set(['json', 'detail', 'visible', 'unselect', 'help', 'stdin', 'attach', 'raw', 'compact', 'state_hide', 'state_show', 'state_auto', 'wait', 'replace', 'reload', 'all']);
  const values = new Set(['mode', 'character', 'source', 'browser', 'session', 'at', 'seconds', 'wait-seconds', 'interval-ms', 'limit', 'to', 'value', 'client', 'port', 'executable', 'from', 'notify', 'notify-thread', 'thread', 'desktop-executable', 'log-mode', 'host', 'turn-seconds', 'target', 'extensions', 'character-packs', 'card-packs', 'observe-seconds', 'game', 'round']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) positional.push(a);
    else {
      const key = a.slice(2);
      if (bools.has(key)) options[key] = true;
      else if (values.has(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[key] = argv[++i];
      else throw new Error('未知参数或缺少值：' + a + '。使用 help 查看命令。');
    }
  }
  return { command: positional[0] || 'help', args: positional.slice(1), options };
}
function formatState(s, options = {}) {
  const out = [`状态 ${s.state} | revision ${s.revision}`];
  if (s.room) out.push(`房间 ${s.room.id} | ${s.room.role} | ${s.room.state}${s.room.controller === 'human' ? ' | 人类操作' : ''}`);
  if (s.room?.role === 'guest' && options.logs === 'experimental') out.push('联机客机事件流覆盖不完整；可用 --log-mode compact 查看原生可见战报。');
  if (s.me && options.state !== 'hide') {
    out.push(`自己 ${s.me.label} (${s.me.name}) ${s.me.id} ${s.me.identity.label || '身份未知'} HP ${s.me.hp}/${s.me.maxHp} 护甲${s.me.armor}${s.me.linked ? " 横置" : ""}${s.me.turnedOver ? " 翻面" : ""}`);
    out.push(s.victory);
    out.push('手牌 ' + s.me.hand.map(c => `${c.id}:${c.label}(${c.suit}${c.number})${c.selected ? '[已选]' : ''}`).join(' | '));
    out.push('自身装备[' + s.me.equipment.map(c=>c.label).join(',') + '] 判定[' + s.me.judgments.map(c=>c.label).join(',') + '] 标记 ' + (s.me.marks||[]).map(m=>`${m.name}${m.count==null?"":":"+m.count}`).join(' '));
  }
  for (const p of options.state === 'hide' ? [] : s.players || []) {
    out.push(`${p.id} ${p.label} ${p.identity.label || '身份隐藏'} HP ${p.hp}/${p.maxHp} 甲${p.armor} 手牌${p.handCount}${p.dead ? ' 已死亡' : ''}${p.linked ? ' 横置' : ''}${p.turnedOver ? ' 翻面' : ''} 装备[${p.equipment.map(c=>c.label).join(',')}] 判定[${p.judgments.map(c=>c.label).join(',')}]${p.marks?.length?' 标记 '+p.marks.map(m=>m.name+(m.count==null?'':':'+m.count)).join(' '):''}`);
    if (Array.isArray(p.hand)) out.push('  队友可见手牌 ' + p.hand.map(c=>`${c.id}:${c.label}(${c.suit}${c.number})`).join(' | '));
  }
  if (options.state === 'hide') out.push('场上概览已隐藏；observe --state_show 可查看。');
  if (s.choice) {
    out.push(`选择 ${s.choice.event}${s.choice.skill ? ' 技能 ' + s.choice.skill : ''}: ${s.choice.prompt}`);
    out.push('数量约束 ' + JSON.stringify(s.choice.constraints));
    for (const o of s.choice.options) out.push(`  ${o.id} ${o.kind} ${o.label}${o.selected ? ' [已选]' : ''}${o.interaction === 'custom' ? ' [原生自定义点击; 已选次数='+o.selectionCount+']' : ''}${o.skill ? ' (' + o.skill + ')' : ''}${o.kind==='number' ? ' 当前='+o.value+' 可选='+o.values.map(v=>v.value+':'+v.label).join(',') : ''}`);
    if (s.choice.groups) out.push('移动区域 ' + JSON.stringify(s.choice.groups));
    out.push(`操作: act <id> --at ${s.revision}`);
  }
  if (s.result) out.push('参与结果 ' + JSON.stringify(s.result));
  if (s.wait) out.push(s.wait);
  if (options.logs === 'experimental') out.push(formatExperimental(s.experimentalLog || { coverage: 'unavailable', entries: [] }));
  else if (s.log) out.push(formatLogs(s.log, { ...options, actors: [s.me, ...(s.players || [])].filter(Boolean).map(p => p.label) }));
  else if (s.recent?.length) out.push('近期记录\n' + s.recent.join('\n'));
  if (options.state !== 'hide') {
    if (s.me?.skills) out.push('自身技能\n' + s.me.skills.map(x => `${x.id} ${x.name}: ${x.description}`).join('\n'));
    if (s.me?.skills && s.me?.marks) out.push('自身标记 ' + JSON.stringify(s.me.marks));
    if (s.me?.skillState) out.push('技能状态 ' + JSON.stringify(s.me.skillState));
    if (s.me?.expansions) out.push('自身附加牌 ' + JSON.stringify(s.me.expansions));
    for (const p of s.players || []) if (p.skills) out.push(`${p.id} 技能/标记/附加牌 ` + JSON.stringify({skills:p.skills,marks:p.marks,expansions:p.expansions}));
  }
  if (s.visibleDialogs) out.push('可见对话框 ' + JSON.stringify(s.visibleDialogs));
  return out.join('\n');
}
function render(value, json, options = {}) {
  if (json) return JSON.stringify(displayConfig.project(value, options), null, 2);
  if (['game-log', 'game-list'].includes(value?.kind)) return require('../src/game-log-store.cjs').format(value);
  if (value?.kind === 'watch') return require('../src/game-log-recorder.cjs').format(value);
  if (value?.wait && typeof value.wait === 'object') {
    const { wait, ...rest } = value;
    const completedAction = value.ok === false && value.actionOutcome === 'completed' && value.action ? `已执行 ${value.action.label}\n` : '';
    return completedAction + render(rest, false, options) + '\n' + waitText(wait);
  }
  if (value?.kind === 'play') {
    const uncertain = code => ['result_unknown', 'session_changed', 'stale_choice', 'action_pending', 'not_choosing', 'choice_changed'].includes(code);
    const paused = item => item.code === 'timeout' ? '超时' : uncertain(item.code) ? '未知' : '等待';
    const mark = step => step.value === 1 ? '1' : step.value === 0 ? '0' : step.status === 'skipped' ? '跳过' : step.status === 'paused' ? paused(step) : '未知';
    const detail = step => {
      if (step.resolved) return ` | ${step.resolved}${step.submission ? '；用牌已提交' : ''}${step.followup ? '；后续选牌' + (step.followup.status === 'completed' ? '已完成' : '未完成') : ''}${step.code ? '；' + [step.code, step.message].filter(Boolean).join(': ') : ''}`;
      const card = typeof step.card === 'string' ? step.card : step.card && (step.card.id || step.card.cardId || step.card.label || step.card.name);
      const actions = (step.actions || []).map(action => typeof action === 'string' ? action : action.id || action.label || action.action?.id || action.action?.label).filter(Boolean);
      const facts = [...(card ? [`牌 ${card}`] : []), ...(actions.length ? [`动作 ${actions.join(' → ')}`] : [])];
      if (step.code || step.message) facts.push([step.code, step.message].filter(Boolean).join(': '));
      return facts.length ? ` | ${facts.join('；')}` : '';
    };
    const result = value.value === 1 ? '1' : value.value === 0 ? '0' : value.status === 'paused' ? paused(value) : '未知';
    const lines = [`play ${result}${value.code || value.message ? ' | '+[value.code,value.message].filter(Boolean).join(': ') : ''}`];
    if (value.operationId) lines.push('收据 ' + value.operationId);
    for (const [index, step] of (value.steps || []).entries()) lines.push(`${index + 1}. ${mark(step)} ${step.raw || ''}${detail(step)}`.trimEnd());
    if (value.remaining != null && (Array.isArray(value.remaining) ? value.remaining.length : String(value.remaining).length)) lines.push('剩余 ' + (Array.isArray(value.remaining) ? value.remaining.join(' | ') : value.remaining));
    if (value.state) lines.push(formatState(value.state, options));
    return lines.join('\n');
  }
  if (value?.source === 'eventflow') return formatExperimental(value);
  if (value?.scope === 'static_public_catalog' && value.character) {
    const c = value.character;
    return `${c.name} (${c.id}) | ${c.sex} ${c.group} | HP ${c.hp}/${c.maxHp} 护甲${c.armor}\n武将包 ${c.packs.join(', ')} | ${c.available ? '当前可选' : '当前不可选：'+c.reason}\n` +
      c.skills.map(s => `${s.name} (${s.id}): ${s.description || '无公开静态说明'}`).join('\n') + '\n' + (value.notes || []).join('\n');
  }
  if (value?.actions && value.epoch) {
    const names={damage:'伤害',loseHp:'失去体力',recover:'回复体力',draw:'摸牌',gain:'获得牌',lose:'失去牌',armor:'护甲变化',dying:'进入濒死',death:'死亡',equip:'装备',judge:'加入判定',equipRemove:'移出装备',judgeRemove:'移出判定',mark:'标记变化'};
    return '效果 '+value.epoch+'（最近 '+value.actions.length+' 条，整体覆盖 '+(value.actions.length?'partial':'暂无')+'）\n'+value.actions.map(a=>a.id+' '+a.name+' '+a.actor+' → '+a.targets.join(',')+' ['+a.status+']\n  '+(a.effects.length?a.effects.map(e=>(names[e.kind]||e.kind)+' '+e.target+(e.amount!=null?' '+e.amount:'')+(e.name?' '+e.name:'')+(e.kind==='mark'?' ['+(e.before??'无')+' → '+(e.after??'无')+']':'')+(e.sourceSkill?' 来源 '+e.sourceSkill:'')).join('；'):'未观测到效果；以各类完备标记判断是否为零')).join('\n');
  }
  if (value?.entries && value.epoch) return formatLogs(value, options);
  if (value?.skills && !value.revision) return value.id+' '+value.label+'\n'+(Array.isArray(value.skills)?value.skills.map(s=>s.id+' '+s.name+': '+s.description).join('\n'):'技能隐藏')+(value.globalSkills?.length?'\n全场附加能力（是否可发动以当前选项为准）\n'+value.globalSkills.map(s=>s.id+' '+s.name+': '+s.description).join('\n'):'')+'\n标记 '+JSON.stringify(value.marks||[]);
  if (value?.completed) return (value.ok?'组合完成':'组合停止 '+value.code+': '+value.message)+'\n已完成 '+value.completed.length+' 步\n'+value.completed.map(x=>x.step+': '+(x.action?.label||x.branch||x.kind)).join('\n')+(value.stoppedAt?'\n停止于 '+value.stoppedAt:'')+(value.branches?.length?'\n分支 '+JSON.stringify(value.branches):'')+'\n'+(value.state?formatState(value.state, options):'状态待核实');
  if (value?.revision) return formatState(value, options);
  if (value?.state?.revision) return (value.ok === false ? `失败 ${value.code}: ${value.message}\n` : value.action ? `已执行 ${value.action.label}\n` : '') + (value.actions?.length ? '已执行 ' + value.actions.map(x=>x.label).join(' → ') + '\n' : '') + formatState(value.state, options);
  return JSON.stringify(value, null, 2);
}
function notificationText(n) {
  return `通知 ${n.status}${n.error ? ': '+n.error : ''}` + (n.enabled ? '；当前没有待选项时可结束本轮，新决策会续接当前 Codex 任务。' : '');
}
function formatRoom(value) {
  return [`房间 ${value.room} | ${value.mode} | ${value.state}`, value.address,
    ...value.members.map(m => `${m.session} | ${m.role} | ${m.controller} | ${m.state}${m.connection ? ' | ' + (m.connection.connected ? (m.connection.waiting ? '等待开局' : '已连接') : '已断开') : ''}`),
    ...(value.error ? [value.error] : [])].filter(Boolean).join('\n');
}
const delay = ms => new Promise(r => setTimeout(r, ms));
function integer(value, fallback, min, max) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`数字应在 ${min}..${max} 范围内。`);
  return n;
}
async function main(argv, locked = false) {
  const { command, args, options: o } = parse(argv);
  if (command === 'help' || o.help) { console.log(HELP); return; }
  if ((o.all || o.game != null || o.round != null) && command !== 'logs') throw Error('--all、--game、--round 只用于 logs。');
  if(command==='setup'){
    if(args.length)throw Error('setup --source 游戏安装目录 [--executable EXE] [--browser EXE]');
    const value=require('../src/installation.cjs').save(o);
    console.log(o.json?JSON.stringify(value):`已保存游戏目录：${value.source}\n配置文件：${value.configFile}\n运行 doctor 检查环境。`);return;
  }
  if (command === 'extension') {
    const ext = require('../src/extensions.cjs');
    const reports = require('../src/extension-reports.cjs');
    if(args.length===2 && args[0]==='watch' && ['on','off','status'].includes(args[1])){
      const monitor=require('../src/runtime-monitor.cjs'),name=o.session || 'default';
      if(o.client&&!['native','isolated'].includes(o.client))throw Error('--client must be native or isolated.');
      const room=!!isolatedSession.read(name)?.room;
      if(room&&o.client==='native')throw Error('Room sessions use isolated clients.');
      const client=room||o.client==='isolated'?'isolated':'native',api=client==='isolated'?isolatedSession:nativeSession;
      const value=args[1]==='on'?await monitor.enable(api,name,client):monitor[args[1]==='off'?'disable':'status'](api.sessionDir(name));
      console.log(o.json?JSON.stringify(value):`错误监听 ${value.status}${value.lastReportId?' | 最近报告 '+value.lastReportId:''}${value.error?' | '+value.error:''}`);
      if(args[1]==='on'&&value.status!=='armed')process.exitCode=1;return;
    }
    if(args.length===1 && args[0]==='reports'){
      const values=reports.list().filter(r=>!o.session||r.session===o.session);console.log(o.json?JSON.stringify({ok:true,reports:values}):values.map(r=>`${r.reportId} | ${r.name || 'unknown'} | ${r.phase} | ${r.code}${r.session?' | '+r.session:''}`).join('\n') || 'no_report');return;
    }
    if(args.length===2 && args[0]==='report'){
      const report=reports.read(args[1]);console.log(o.json?JSON.stringify(report):[`${report.name || 'unknown'} | ${report.phase} | ${report.code}`,report.session?`会话 ${report.session} | ${report.client}`:report.zip,...report.events.map(e=>`${e.message}${e.source ? '\n  '+e.source.file+':'+(e.source.line || '?')+':'+(e.source.column || '?'):''}\n${e.stack}`)].filter(Boolean).join('\n'));return;
    }
    if (o.target && !['native','room'].includes(o.target)) throw Error('--target must be native or room.');
    if (o.client) throw Error('extension uses --target native|room, not --client.');
    let value;
    if (args.length === 1 && args[0] === 'list' && (!o.target || o.target === 'room')) value = ext.list();
    else if (args.length === 2 && args[0] === 'import' && o.target) {
      if (o.target === 'room' && o.reload) throw Error('--reload applies only to native import; room imports apply to new rooms.');
      value = await ext.reportedImport(args[1],o);
    } else throw Error('extension import ZIP --target room|native [--replace] [--reload] | extension list');
    console.log(o.json ? JSON.stringify(value) : value.extensions ? value.extensions.map(e => `${e.name} | ${e.sha256.slice(0,12)}`).join('\n') || 'no_extension' : `${value.name} 导入成功${value.target === 'room' ? '，供新房间使用' : value.restartRequired ? '，重载游戏后生效' : '，已重载'}${value.backup ? '\n备份：'+value.backup : ''}`);
    return;
  }
  if (command === 'room') {
    const [action, id] = args;
    if (args.length !== 2 || !['create','join','start','status','leave','close'].includes(action)) throw Error('room create|join|start|status|leave|close NAME');
    const rooms = require('../src/room.cjs');
    const value = action === 'create' ? await rooms.create(id, { ...o, timeout: o['turn-seconds'] }) : action === 'join' ? await rooms.join(id, o) : action === 'leave' ? await rooms.leave(id, o.session) : await rooms[action](id);
    console.log(o.json ? JSON.stringify(value) : formatRoom(value));
    if (value.ok === false) process.exitCode = 1;
    return;
  }
  if (o.wait && !['act', 'play'].includes(command) || o['wait-seconds'] !== undefined && !(['act', 'play'].includes(command) && o.wait)) throw new Error('--wait 与 --wait-seconds 只用于 act --wait 或 play --wait。');
  if (o['interval-ms'] !== undefined && command !== 'play') throw new Error('--interval-ms 只用于 play。');
  if (command === 'play') {
    if (!o.at) throw new Error('play 需要 --at 当前revision。先 observe。');
    if (o.stdin ? args.length !== 0 : args.length !== 1) throw new Error('play 需要一个完整表达式，或用 --stdin 单独读取。');
    if (o.unselect || o.to || o.value != null) throw new Error('--unselect、--to、--value 只用于单步 act；play 中请写入 act(...)。');
  }
  const waitSeconds = o.wait ? integer(o['wait-seconds'], 15, 1, 60) : null;
  const playTimeoutMs = command === 'play' ? integer(o.seconds, 30, 1, 60) * 1000 : null;
  const playIntervalMs = command === 'play' ? integer(o['interval-ms'], 500, 0, 5000) : null;
  if (command === 'config') {
    let settings;
    if (!args.length) settings = displayConfig.read();
    else if (args.length === 1 && args[0] === 'reset') settings = displayConfig.save(displayConfig.DEFAULTS);
    else if (args.length === 3 && args[0] === 'set') settings = displayConfig.save({ ...displayConfig.read(), [args[1]]: args[2] });
    else throw new Error('config | config set logs classic|compact|experimental | config set state auto|show|hide | config reset');
    console.log(JSON.stringify({ ...settings, file: displayConfig.CONFIG_PATH }, null, 2));
    return;
  }
  const display = displayConfig.resolve(displayConfig.read(), o);
  const name = o.session || 'default';
  const roomState = isolatedSession.read?.(name);
  const isRoom = !!roomState?.room;
  if (o.client && !['native','isolated'].includes(o.client)) throw new Error('--client 只能为 native 或 isolated。');
  if (isRoom && o.client === 'native') throw Error('房间 session 已绑定独立客户端，不接受 --client native。');
  const clientKind = isRoom || o.client === 'isolated' ? 'isolated' : 'native';
  const session = clientKind === 'isolated' ? isolatedSession : nativeSession;
  const setup = clientKind === 'isolated' ? isolatedSetup : nativeSetup;
  const contentFlags = ['extensions', 'character-packs', 'card-packs'].some(key => Object.prototype.hasOwnProperty.call(o, key));
  if (contentFlags && !(clientKind === 'isolated' && ['start', 'restart'].includes(command))) throw new Error('扩展与包列表只用于 room create，或显式 --client isolated 的 start/restart；native 沿用游戏内配置。');
  if (isRoom && ['start','restart'].includes(command)) throw Error('联机会话使用 room 命令管理；重开房间需先 room close，再 room create。');
  if (isRoom && command === 'stop') {
    const value = await require('../src/room.cjs').leave(roomState.room.id, name);
    console.log(o.json ? JSON.stringify(value) : formatRoom(value)); return;
  }
  if (o.mode === '2v2' && o.client === 'isolated') throw new Error('2v2 使用原客户端；请使用默认 native。');
  if (!locked && ['start', 'restart', 'act', 'play', 'stop', 'notify', 'watch'].includes(command) && !(['notify', 'watch'].includes(command) && args.length === 1 && args[0] === 'status')) return session.withLock(name, () => main(argv, true));
  let emitted = false;
  const emit = value => {
    let feedback, rendered;
    try {
      feedback = displayFeedback.prepare(session.sessionDir?.(name), value, display, { json: !!o.json });
      rendered = render(value, o.json, feedback.options) + (!o.json && value?.notification ? '\n'+notificationText(value.notification) : '') + (!o.json && value?.errorMonitor ? '\n错误监听 '+value.errorMonitor.status+(value.errorMonitor.error?'：'+value.errorMonitor.error:'') : '') + (!o.json && value?.gameLogRecorder ? '\n观战记录 '+value.gameLogRecorder.status+(value.gameLogRecorder.error?'：'+value.gameLogRecorder.error:'') : '');
    } catch (error) {
      if (value?.kind !== 'play') throw error;
      rendered = JSON.stringify({ ...value, state: undefined, feedbackError: error.message, mustObserve: true });
    }
    console.log(rendered); emitted = true;
    try { feedback?.commit(); } catch (error) { if (value?.kind !== 'play') throw error; }
    if (value?.ok === false) process.exitCode = 1;
  };
  if (command === 'watch') {
    if (args.length !== 1 || !['on', 'off', 'status'].includes(args[0])) throw Error('watch on|off|status');
    const recorder = require('../src/game-log-recorder.cjs'), dir = session.sessionDir(name);
    if (args[0] === 'status') return emit(recorder.status(dir));
    if (args[0] === 'off') return emit(await recorder.disable(dir));
    // Starting observation never prepares a game, changes packs, or selects a general.
    if (!(await session.status(name)).running) {
      if (clientKind !== 'native') throw Error('请先创建房间或启动 isolated 会话。');
      await session.start({ session: name, source: o.source, executable: o.executable, port: o.port, attach: !!o.attach });
    }
    const value = await recorder.enable(session, name, clientKind);
    emit({ ...value, ok: value.status === 'recording' }); return;
  }
  if (command === 'logs') {
    if (args.length && !(args.length === 1 && args[0] === 'games')) throw Error('logs [--all | --game ID] 或 logs games');
    const archived = o.all || o.game != null || o.round != null || args[0] === 'games';
    if (o.to != null && !archived) throw Error('--to 用于归档战报，请加 --all 或 --game ID。');
    if (archived) {
      if (o.raw || o.compact || o['log-mode'] && o['log-mode'] !== 'experimental') throw Error('归档战报使用实验模式；请移除 classic/compact/raw 覆盖。');
      if (args[0] === 'games' && (o.all || o.game || o.round || o.from || o.to)) throw Error('logs games 不接受战报筛选条件。');
      const from = integer(o.from, 1, 1, Number.MAX_SAFE_INTEGER), to = integer(o.to, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
      const round = o.round == null ? undefined : integer(o.round, 1, 0, Number.MAX_SAFE_INTEGER);
      if (from > to) throw Error('--from 不能大于 --to。');
      const store = require('../src/game-log-store.cjs'), archive = await store.load(session.sessionDir(name));
      const recording = require('../src/game-log-recorder.cjs').status(session.sessionDir(name));
      if (recording.enabled && !['recording', 'stopped'].includes(recording.status)) archive.warnings.push('后台记录器 ' + recording.status + (recording.error ? '：' + recording.error : '') + '；以下仅为已保存记录。');
      return emit(args[0] === 'games' ? store.catalog(archive) : store.select(archive, { game: o.game || 'latest', from, to, round }));
    }
  }
  if (command === 'receipt') {
    if (args.length > 1) throw Error('receipt 只接受一个可选的调用 ID。');
    const file = path.join(session.sessionDir(name), 'evidence.jsonl');
    let latest = null;
    if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      try { const row = JSON.parse(line); if (row.operationId && row.output?.kind === 'play' && (!args[0] || row.operationId === args[0])) latest = { ...row.output, operationId: row.operationId }; } catch { /* Ignore an interrupted last append. */ }
    }
    emit(latest ? { ...latest, state: undefined, stateFresh: false, mustObserve: true } : { ok: false, code: 'receipt_unavailable', message: '没有找到此会话的 play 收据。' });
    return;
  }
  const notificationDir = () => session.sessionDir(name);
  if (o.notify && (command !== 'start' || o.notify !== 'codex-desktop')) throw new Error('--notify codex-desktop 只用于 start；已有会话使用 notify on。');
  if ((o['notify-thread'] || o['desktop-executable'] || o.thread) && !(command === 'start' && o.notify || command === 'notify' && args[0] === 'on')) throw new Error('通知目标参数只用于 start --notify 或 notify on。');
  let binding;
  if (o.notify || command === 'notify' && args[0] === 'on') {
    binding = await require('../src/codex-delivery.cjs').resolveBinding({ threadId: o.thread || o['notify-thread'], executablePath: o['desktop-executable'] });
  }
  if (command === 'notify') {
    if (args.length !== 1 || !['on', 'off', 'status'].includes(args[0])) throw new Error('notify on|off|status');
    const dir = notificationDir();
    if (args[0] === 'status') return emit(notifications.status(dir));
    if (args[0] === 'off') return emit(notifications.disable(dir));
    const { cdp, state } = await session.connect(name);
    try {
      const snapshot = await page.observe(cdp);
      notifications.enable(dir, binding, state, snapshot, { detail: !!o.detail });
      const notification = notifications.ensureWorker(dir, name, clientKind);
      await session.appendEvidence(name, { command: 'notify_on', output: notification });
      return emit({ ok: true, state: snapshot, notification });
    } finally { cdp.close(); }
  }
  if (command === 'doctor') return emit(await session.doctor(o));
  if (command === 'status') return emit(await session.status(name));
  if (command === 'stop') {
    notifications.disable(notificationDir(), 'stopped');
    try {
      const { cdp } = await session.connect(name);
      try { const final = await page.observe(cdp); await session.appendEvidence(name, { command: 'participation_stop', output: { mode: final.mode, character: final.me?.name, state: final.state, result: final.result || { outcome: 'abandoned', finalOutcome: 'unobserved' } } }); }
      finally { cdp.close(); }
    } catch (error) { if (session.read(name)) await session.appendEvidence(name, { command: 'stop_observation_unavailable', error: error.message }); }
    return emit(await session.stop(name));
  }
  if (command === 'history') {
    const state = await session.read(name);
    if (!state) throw new Error('会话不存在。先 start。');
    const file = path.join(state.evidenceDirectory, 'evidence.jsonl');
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-integer(o.limit, 20, 1, 200)).map(x=>JSON.parse(x)) : [];
    return emit(lines.map(r => ({ time: r.time || r.timestamp, command: r.command || r.type, attempt: r.attempt, action: r.output?.action, state: r.output?.state?.state || r.output?.state, result: r.output?.result || r.output?.state?.result, error: r.error, recent: r.output?.recent || r.output?.state?.recent })));
  }
  if (!['start', 'characters', 'character', 'observe', 'act', 'play', 'wait', 'rule', 'restart', 'diagnose', 'inspect', 'logs', 'effects'].includes(command)) throw new Error('未知命令：' + command + '。使用 help。');
  let startupMonitor, startupRecorder;
  if (command === 'start') {
    if (!o.character || !['identity', 'doudizhu', '2v2'].includes(o.mode)) throw new Error('start 需要 --mode identity|doudizhu|2v2 和 --character ID。');
    if ((await session.status(name)).running) throw new Error('会话已经运行；使用 observe 继续，或使用 restart 明确重开。');
    const started = await session.start({ ...o, session: name });
    startupMonitor = started?.errorMonitor; startupRecorder = started?.gameLogRecorder;
  }
  const { cdp, state } = await session.connect(name);
  const intentFile = path.join(state.evidenceDirectory, 'task.json');
  let intent = fs.existsSync(intentFile) ? JSON.parse(fs.readFileSync(intentFile, 'utf8')) : { attempt: 0 };
  let output, operationId;
  const playSummary = value => ({ ...value, operationId, completedSteps: (value.steps || []).filter(s => s.status === 'completed').length,
    settlement: value.stateFresh === false ? 'unknown' : value.state?.state === 'running' ? 'pending' : 'observed',
    mustObserve: value.stateFresh === false || (value.steps || []).some(s => s.inFlight?.status === 'unknown') });
  async function evidence(record) {
    try { await session.appendEvidence(name, record); }
    catch (error) {
      if (command !== 'play' || !output) throw error;
      output = { ...output, evidenceError: error.message };
    }
  }
  try {
    if (['act', 'play', 'restart'].includes(command) && session.sessionDir) notifications.beginOperation?.(notificationDir(), { restart: command === 'restart' });
    if (command === 'start' || command === 'restart') {
      if (command === 'restart') {
        const previous = await page.observe(cdp, true);
        await session.appendEvidence(name, { command: 'participation_end', attempt: intent.attempt, output: { mode: previous.mode, character: previous.me?.name, state: previous.state, result: previous.result || { outcome: 'abandoned', finalOutcome: 'unobserved' } } });
      }
      const target = { mode: o.mode || intent.mode, character: o.character || intent.character, ...(clientKind === 'isolated' ? contentProfiles.resolve(o, intent) : {}) };
      if (!target.character || !['identity', 'doudizhu', '2v2'].includes(target.mode)) throw new Error('缺少有效模式/武将；请提供 --mode 和 --character。');
      intent = { ...target, attempt: intent.attempt + 1 };
      fs.writeFileSync(intentFile, JSON.stringify(intent, null, 2));
      await session.appendEvidence(name, { command: 'participation_start', ...intent });
      const prepared = await setup.prepare(cdp, {...target,onConfigChanges:changes=>session.appendEvidence(name,{command:'config_changes',changes})});
      output = prepared?.ok === false ? prepared : { ok: true, setup: prepared, state: await page.observe(cdp) };
    } else if (command === 'observe') output = await page.observe(cdp, o.detail);
    else if (command === 'act') {
      if ((!args[0] && !o.stdin) || !o.at) throw new Error('act 需要选项id和 --at 当前revision。先 observe。');
      if ((args.length>1 || o.stdin || args[0]?.includes('>') || args[0]?.startsWith('skill:') || args[0]?.trim().startsWith('{')) && (o.unselect || o.to || o.value!=null)) throw new Error('数值、移动、取消选择需单独提交。');
      if (o.stdin || args.length===1 && (args[0].includes('>') || args[0].startsWith('skill:') || args[0].trim().startsWith('{'))) {
        if (o.stdin && args.length) throw new Error('--stdin 不可同时提供位置操作。');
        const input = o.stdin ? fs.readFileSync(0,'utf8') : args[0];
        if (Buffer.byteLength(input)>1048576) throw new Error('计划超过1MB。');
        const plan = input.trim().startsWith('{') ? JSON.parse(input) : parsePlan(input);
        validatePlan(plan);
        output = await executePlan(plan,{observe:()=>page.observe(cdp),act:r=>page.act(cdp,r),effects:()=>page.effects(cdp),sleep:delay},{at:o.at,timeoutMs:integer(o.seconds,30,1,60)*1000,maxSteps:64});
      } else output = args.length>1 ? await page.actMany(cdp,{ids:args,at:o.at}) : await page.act(cdp, { id: args[0], at: o.at, unselect: !!o.unselect, to: o.to, value: o.value });
      if (o.wait) output = await waitAfterAction(output, { observe: () => page.observe(cdp, o.detail), sleep: delay }, { seconds: waitSeconds });
    } else if (command === 'play') {
      const input = o.stdin ? fs.readFileSync(0, 'utf8') : args[0];
      if (Buffer.byteLength(input) > 1048576) throw new Error('play 表达式超过1MB。');
      if (!input.trim()) throw new Error('play 表达式不能为空。');
      const plan = parsePlay(input);
      operationId = randomUUID();
      output = await executePlay(plan, { observe: () => page.observe(cdp), act: request => page.act(cdp, request), effects: () => page.effects(cdp), sleep: delay },
        { at: o.at, timeoutMs: playTimeoutMs, intervalMs: playIntervalMs, ...(o.wait ? { deferFinalWait: true } : {}),
          onProgress: async progress => { output = playSummary(progress); await evidence({ command: 'play_progress', operationId, output }); } });
      output = playSummary(output);
      await evidence({ command: 'play_progress', operationId, output });
      if (o.wait) output = await waitAfterAction(output, { observe: () => page.observe(cdp, o.detail), sleep: delay }, { seconds: waitSeconds });
    } else if (command === 'inspect') { if (!args[0] || args[1] && args[1]!=='skills') throw new Error('inspect PLAYER skills'); output=await page.inspect(cdp,{id:args[0]}); }
    else if (command === 'logs') {
      const request=o.from==null?{}:{since:integer(o.from,1,1,Number.MAX_SAFE_INTEGER)-1};
      output=display.logs === 'experimental' ? await page.eventLogs(cdp,request) : await page.logs(cdp,request);
      if (!o.json && !display.raw && display.logs !== 'experimental') {
        // A public roster gives the formatter real actor boundaries. If it is
        // unavailable, keep original lines rather than infer actor names.
        try { const snapshot = await page.observe(cdp); display.actors = [snapshot.me, ...(snapshot.players || [])].filter(Boolean).map(p => p.label); }
        catch { display.actors = []; }
      }
    }
    else if (command === 'effects') { output=await page.effects(cdp); const total=output.actions.length; const limit=integer(o.limit,o.json?200:10,1,200); output={...output,total,actions:output.actions.slice(-limit)}; }
    else if (command === 'characters') output = await setup.characters(cdp, { query: args[0] || '' });
    else if (command === 'character') { if (args.length !== 1) throw new Error('character 需要一个精确武将ID；先 characters 搜索。'); output = await setup.character(cdp, args[0]); }
    else if (command === 'rule') { if (!args[0]) throw new Error('rule 需要技能或卡牌 ID。'); output = await page.rule(cdp, args[0]); }
    else if (command === 'wait') {
      const until = Date.now() + integer(o.seconds, 15, 1, 60) * 1000;
      do { output = await page.observe(cdp, o.detail); if (['choice','dead','over','disconnected'].includes(output.state)) break; await delay(250); } while (Date.now() < until);
      if (!['choice','dead','over','disconnected'].includes(output.state)) output.wait = 'timeout; 可再次 wait 或 diagnose';
    } else if (command === 'diagnose') {
      let observed; try { observed=await page.observe(cdp,true); } catch(error) { observed={state:'unavailable',error:error.message}; }
      output={connection:await session.status(name),diagnostics:await cdp.evaluate('window.__oneshotDiagnostics || []'),document:await cdp.evaluate('({url:location.href,readyState:document.readyState,importmaps:document.querySelectorAll("script[type=importmap]").length})'),state:observed,recovery:'选择未出现可 wait；失效选项先 observe；页面故障可 restart，已记录的参与仍保留。'};
    }
    if(startupMonitor)output.errorMonitor=startupMonitor;
    if(startupRecorder)output.gameLogRecorder=startupRecorder;
    if (command === 'play') output = playSummary(output);
    await evidence({ command, ...(operationId ? { operationId } : {}), attempt: intent.attempt, input: { args, ...o }, output });
    if (['start', 'restart', 'act', 'play'].includes(command) && session.sessionDir) {
      const dir = notificationDir(), snapshot = output?.state;
      // Synchronous feedback already delivers this decision to the agent. Do
      // not emit it a second time. Plans remain under the same operation lock.
      try {
        if (binding) notifications.enable(dir, binding, state, snapshot, { detail: !!o.detail });
        else if (output?.stateFresh !== false) notifications.acknowledge(dir, state, snapshot, { restart: command === 'restart' || command === 'start' });
        if (notifications.read(dir)?.enabled) output.notification = notifications.ensureWorker(dir, name, clientKind);
      } catch (error) { output.notification = { enabled: false, status: 'unavailable', error: error.message }; }
    }
    emit(output);
    if (['act', 'play'].includes(command) && output?.state?.log && output.stateFresh !== false) {
      try {
        const committed = await page.commitLogs(cdp,{epoch:output.state.log.epoch,to:output.state.log.to,...(output.state.experimentalLog?.epoch ? {eventEpoch:output.state.experimentalLog.epoch,eventTo:output.state.experimentalLog.to} : {})});
        if (committed?.ok === false) throw Object.assign(Error('已输出动作结果，但日志游标提交失败；不要重放动作。'), { code: committed.code || 'log_commit_failed' });
      } catch (error) {
        error.code ||= 'log_commit_failed';
        error.details = { phase: 'log_commit', output };
        throw error;
      }
    }
  } catch (error) {
    if (command === 'play' && output?.kind === 'play') {
      output = playSummary({ ...output, ok: false, stateFresh: false, code: error.code || 'feedback_failed', message: error.message });
      await evidence({ command, operationId, output, error: error.message });
      if (!emitted) emit(output);
      process.exitCode = 1;
      return;
    }
    await session.appendEvidence(name, { command, attempt: intent.attempt, error: error.message, ...(output ? { output } : {}) });
    throw error;
  } finally { cdp.close(); }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ ok: false, code: error.code || 'command_failed', message: error.message, details: error.details, hint: '查看 help；连接故障使用 status/diagnose。需要重建会话时先 stop 再 start。' }, null, 2)); process.exitCode = 1; });
module.exports = { parse, formatState, formatLogs, render, main };

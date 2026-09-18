# 固定阵容测试房

用于用户要求多个 Agent 使用指定武将对战，或固定斗地主身份、2v2 队伍。
`test-room` 创建独立客户端并完成选将；模型控制者由当前 Agent 环境安排。
只有负责建房的协调者执行本页的创建、开局和整房关闭。已经获得 session 的
参与者直接 `observe`，随后按主文档的滚动规划使用 `play / wait`。

## 准备阵容

在工具目录运行 `node bin/noname.cjs help`，确认包含 `test-room`（.9 起提供）。
源码入口在 `next/`，发行 ZIP 的入口在解压根目录。旧版本先报告能力缺失，
不改用单机的 `start --character` 来伪装联机对战。

将用户选定的精确武将 ID、session 和阵营写入 JSON 文件。普通斗地主示例：

```json
{
  "mode": "doudizhu",
  "seats": [
    { "session": "agent-a", "character": "caocao", "identity": "zhu" },
    { "session": "agent-b", "character": "guanyu", "identity": "fan" },
    { "session": "agent-c", "character": "zhangfei", "identity": "fan" }
  ]
}
```

- 第一席是 Agent 房主；其余席位自动加入，不再单独执行 `room join`。
- 斗地主要求三席，一名 `zhu`（地主）、两名 `fan`（农民）。2v2 要求四席，
  `mode` 为 `2v2`，每席用 `team: "A"` 或 `"B"` 代替 `identity`，各两人。
- 当前不支持双人 1v1、双将或重复武将。两个 Agent 不等于两个席位：要补齐模式
  所需席位及控制者；可按用户约定让同队 session 共用控制者，不把对手私有观察
  混入另一方上下文。缺少会影响测试目的的武将或阵营配置时，先澄清再建房。
- session 名须唯一且未被占用。阵容顺序不固定实际座位、先手或牌堆；2v2 指定
  队伍可能改变原生随机分队时队友相邻的布局。

## 创建与核验

以下命令在工具目录运行，`duel` 与 `lineup.json` 替换为本次房间名和阵容路径：

```powershell
node bin/noname.cjs test-room create duel --lineup lineup.json
node bin/noname.cjs test-room start duel --json
```

创建时按需要追加 `--extensions EXTENSION_FOLDER --character-packs PACK_ID`，
卡牌包用 `--card-packs CARD_PACK_ID`。沿用[会话与内容配置](sessions.md)中的内容
标识规则。`--visible` 显示客户端，`--turn-seconds` 设置思考时限（默认 600 秒）；
客户端使用独立配置，原安装的启用状态不会自动带入。

`create` 冻结阵容并建立客户端；`start` 检查全端内容及合法性，按玩家身份绑定
候选，完成原生选将，再比较所有客户端看到的武将和身份/队伍。
以 `testRoom.status: "verified"` 及 `testRoom.snapshots` 确认开局；这只证明
阵容同步，不证明整场完成或全部技能兼容。开局后的换手牌、技能询问交给参与者。

```powershell
node bin/noname.cjs observe --detail --session agent-a
node bin/noname.cjs play "act(OPTION)" --at REV --wait --session agent-a
```

每个参与者只使用自己 session 的观察、选项和最新 revision。定向选将和原生按钮
确认已经由 `test-room start` 完成，不需要手动打开自由选将或再调用 `start`。

## 失败与清理

`test_character_not_loaded` 表示武将或启用包缺失；`test_character_disabled` 表示
原生候选限制，包括 `forbidai`。本版没有绕过禁选的开关，不自动换武将。
`test_room_incompatible` 表示模式配置或原生选将结构不受支持。
开局前失败保留大厅；调整阵容需关闭并重建，因为修改文件不会更新已冻结的阵容。
开局过程失败会保留原因并尝试关闭本测试房所有客户端；清理未完成会明确报错。

```powershell
node bin/noname.cjs test-room status duel --json
node bin/noname.cjs test-room close duel
```

`status` 的 `verified` 是历史开局结果；当前连接看 `members[].connection`。
客机仅离开自己时用 `room leave duel --session NAME`；房主拥有整盘生命周期，
应由协调者按用户约定在测试结束后 `test-room close`。参与者死亡不意味着整房
可以关闭。保留会话时交回房间名、session 和当前观察结果。

本地子琪 v1.11.3 的斗地主、2v2 和一组 Nihilphile 武将已验证开局。官方版联机、
任意扩展技能及整场对战仍需另验；更多实现与限制见工具目录 `docs/TEST-ROOM.md`。

# 固定武将测试房

`test-room` 在工具创建的独立联机房间里固定每个 Agent session 的武将，以及
斗地主身份或 2v2 队伍。第一项是房主，其余项自动创建独立客机。无需手动加入。
它不启动模型；开局之后，各 Agent 继续使用自己的 `observe / act / play / wait`。

在 `next` 目录运行：

```powershell
node bin/noname.cjs test-room create duel --lineup examples/test-room-doudizhu.json
node bin/noname.cjs test-room start duel
node bin/noname.cjs observe --session test-a
node bin/noname.cjs observe --session test-b
node bin/noname.cjs test-room status duel
node bin/noname.cjs test-room close duel
```

阵容示例：

```json
{
  "mode": "doudizhu",
  "seats": [
    { "session": "test-a", "character": "caocao", "identity": "zhu" },
    { "session": "test-b", "character": "guanyu", "identity": "fan" },
    { "session": "test-c", "character": "zhangfei", "identity": "fan" }
  ]
}
```

- 使用精确武将 ID；斗地主必须有三席、一名 `zhu`（地主）和两名 `fan`（农民）。
- 2v2 使用 `mode: "2v2"`，每席写 `team: "A"` 或 `"B"`，各两人；见
  [2v2 示例](../examples/test-room-2v2.json)。
- session 名不能重复或与正在使用的会话冲突；暂不支持重复武将、双将、双人 1v1。
- seats 数组只指定房主和 session，不表示实际行动顺序。身份/队伍固定，座位、
  先手、洗牌不固定，不是随机种子固定的重放环境。2v2 按阵容分队，可能改变原生
  随机组队下队友相邻的座次布局；测试结果应结合实际座次解释。
- 每个席位都要有控制者。两个 Agent 可各负责多个同队 session，但本工具不会自动
  把额外席位托管给游戏 AI。

自制包仍使用现有内容参数，例如：

```powershell
node bin/noname.cjs test-room create custom --lineup my-lineup.json --extensions Nihilphile --character-packs nihilphile
```

只启用原安装已存在或通过 `extension import ... --target room` 导入的包。
`create` 还接受 `--source`、`--browser`、`--visible`、`--turn-seconds 600`。
所有命令支持 `--json`；不需要改全局安装配置。测试房使用软件渲染，降低多个
独立浏览器并发时的 GPU 启动问题；普通 `room` 保持原有行为。

## 开局保证与失败处理

`create` 冻结阵容并建立客户端。`start` 会在所有客户端检查目标武将已加载、
所属包已启用且未被联机规则禁用，再按原生玩家身份绑定各 session。
房主将每席候选改为对应的唯一精确武将，不经过“同名武将替换”随机选择。
随后通过各客户端的原生选将按钮及确认按钮完成选择。

返回 `verified` 表示每个客户端看到的所有武将、身份/队伍与阵容一致、客户端
仍连接且没有托管。JSON 中的 `testRoom.snapshots` 保存开局核对证据，仅含公开
武将、身份、队伍及玩家 ID，不读取手牌。它是**开局证据**，不是当前连接健康状况
或完整对局通过证明；实时连接查看 `status` 的 `members[].connection`。

开局前校验失败不会点击开始，可关闭房间后调整阵容文件重建。
本版保留原生候选限制，包括 `forbidai`；虽然席位由外部 Agent 控制，原生联机
候选仍会过滤这类武将。例如本地包的普通樱华 `nihil_yinhua` 属于此限制，错误中
会注明原因；本版没有提供强行绕过禁选的开关。
开局过程中失败或三十秒内无法完成选将，会记录 `failed` 及原因并关闭本测试房
的所有客户端，避免把随机将或部分成功当成有效测试。清理未完成会明确返回错误。
普通 `room start` 对测试房也执行同样的校验，不能绕过测试开局流程。
创建时若房主启动失败，可用 `test-room close NAME` 清理保留的失败记录。

## 模块与适用范围

- `test-room.cjs`：阵容、创建流程、开局校验与全端核对。
- `test-room-runtime.cjs`：隔离房间内的模式适配与原生选将操作。
- `room.cjs`：继续拥有房间、成员、锁和生命周期；只在测试房启动时调用上述模块。

适配仅修改工具拥有的房主进程内存，原游戏安装文件只读。原生事件步骤、武将
初始化、地主体力加成、开局触发和网络广播仍由引擎执行。适配器匹配已核查的
原生选将代码结构；结构不符会拒绝开局，不尝试猜测替换。

当前目标为本地子琪 v1.11.3 的普通斗地主和联机 2v2。其他版本（包括官方版）
需单独验证。固定武将成功不证明自制技能完全兼容联机，仍需用实际对局验收。

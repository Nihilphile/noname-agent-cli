# 人类游玩与整局实验战报

人类操作游戏，工具在后台保存实验事件；Agent 随时按局读取文本战报。以下命令在 `next` 目录运行。无需修改 Skill 或游戏配置。

## 开启记录

```powershell
node bin/noname.cjs watch on --session human
node bin/noname.cjs watch status --session human
```

`watch on` 使用原客户端：已有可连接会话时复用，否则打开本机配置的游戏。人类在窗口里选将、开局、操作。它不执行 `setup.prepare`，不切换模式、武将池或扩展，不托管、不点击、不回答对话框。只想接入已打开的客户端可加 `--attach`。原客户端如果未开放调试端口，命令会说明需要怎样重新打开，不会擅自关闭它。

通过工具 `start` 或 `room create/join` 创建的新会话也会自动启用记录。旧会话用同名 `watch on` 补开；已有隔离会话加 `--client isolated`，房间 session 自动识别。`extension watch` 仍只控制错误监听，与战报记录互不影响。

`recording` 表示本次采集成功。`starting/connecting/degraded/unresponsive/unavailable` 都不能当作正在可靠录制；具体原因见 `watch status`。页面加载期间会重试；重载后自动建立新的日志分局。记录器没有收到游戏结束信号时，历史列表会显示“结局未确认”；玩家死亡不会停止采集。

## 直接阅读整局

```powershell
node bin/noname.cjs logs --all --session human
node bin/noname.cjs logs games --session human
node bin/noname.cjs logs --game g-0123456789abcdef --session human
node bin/noname.cjs logs --game g-0123456789abcdef --round 2 --session human
node bin/noname.cjs logs --all --from 100 --to 180 --session human
```

把示例 `g-…` 换成 `logs games` 返回的 ID。`--all` 默认最近一局，`--game latest` 等价；局 ID 根据实验日志 epoch 生成，不随列表顺序变化。列表限当前 session，原客户端与隔离客户端的存储分开。

默认输出实验模式文本，直接包含原来的回合、阶段、用牌、响应及实际状态变化，不额外生成胜负原因或伤害总结。`--round` 是游戏的轮数，`--from/--to` 是事件序号的闭区间，不是文本行号。筛选保留整局角色名消歧信息。需要结构化数据时再加 `--json`。

这些命令只读本地归档，关闭游戏后也能使用；进行中的对局可能比界面落后约一次采样（正常约 0.5 秒）。输出保留最后记录时间。普通 `logs --from N --log-mode experimental` 继续读取当前页面缓存，行为不变。`history` 仍用于操作调用证据，整局复盘请用上述 `logs` 入口。

## 停止、恢复与覆盖边界

```powershell
node bin/noname.cjs watch off --session human
```

只停录，不关窗口、不改人类控制。记录器会尝试保存最后一批事件；失败原因保留在状态中。`stop` 也会先停录再关闭/脱离客户端。人类手动关窗时保留已经落盘的部分，突然退出前尚未采集的事件可能缺失。关窗后 `logs --all` 不会重新打开游戏。

新记录存于 session 目录的 `game-log.jsonl`，保存的是玩家可见实验日志及公开模式/轮次/终局状态，不保存原始手牌对象、待选按钮或引擎对象。后台使用自己的游标，不提交 `act/play` 的增量游标；每批落盘成功后才前移。进程重启造成的重复批次按 `(epoch, seq)` 去重。

读取时也会合并旧 `evidence.jsonl` 中已经存在的实验日志，因此旧局不需要重新转换文件。损坏/未写完的 JSON 行会提示并跳过，事件序号缺口会单独列出。未开启观察前的事件、页面缓存已淘汰且从未落盘的事件无法补回；只有原生文字日志而没有实验事件的旧局也不能伪造恢复。

页面保留约 2000 条事件；后台持续落盘后归档不再受此总量限制。不过一次采样前发生超过缓存容量的事件，或后台长时间不可用，仍可能出现缺段。常规重新开局会刷新页面，按新 epoch 分局；同一页面内部由扩展私自重置对局但不更新日志 epoch 的情况尚未支持独立分局。

“整局”表示读取所选局的全部已存实验事件，不承诺完整记录每一种引擎事件。保留 `experimental_partial` 覆盖标记，联机客机额外保留 `partial_online`；开局起点尚未有可靠的捕获证明，即使序号连续也明确显示“开局起点未验证”。

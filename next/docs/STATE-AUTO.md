# 全场状态自动显示

默认 `state=auto`：自己每个真实出牌阶段，首个成功输出的决策反馈显示一次全场概览，之后隐藏同阶段的重复概览。自己的其他阶段、回合外响应均隐藏概览。需要查看全场时，主动调用 `observe`，可重复查看。文本和 JSON 共用这次自动展示机会。选择、revision、结果和战报一直保留。日志仍按原有增量/截断契约返回，不因隐藏全场而消费或丢弃。

```text
config set state auto
observe
observe --state_auto
observe --state_show
observe --state_hide
```

`show` 始终显示，并计入该阶段已展示；`hide` 始终隐藏，不消耗该阶段第一次自动展示机会。动作失败、过期快照和输出失败也不消耗这次机会。成功输出的 JSON 与文本一样记录展示。三个单次覆盖参数不能混用。已有明确保存的 show/hide 设置继续生效；未配置及 config reset 使用 auto。

默认 auto 下，`observe`（包括 `observe --json`）始终显示全场；`observe --detail` 额外取得详细技能和标记。主动观察自己出牌阶段的有效决策也计入已展示，之后自动反馈隐藏概览。若同时显式指定 `--state_hide` 或 `--state_auto`，则尊重该状态覆盖参数。已保存的 hide 配置仍保留原有行为，可用 `observe --state_show` 单次显示。默认文本首行只保留 `状态 … | revision …`；JSON 在隐藏概览时仍保留 mode、submode、round、phase、actor 和 revision 等定位字段。

## 阶段识别

页面快照提供 `actor`、`phase` 和 `phaseId`。`phaseId` 由当前游戏 epoch 与真实 `phaseUse` 事件对象 ID 组成。只有 `actor` 是自己且 `phase=phaseUse` 时使用每阶段收据；别人回合的响应不写收据。不同子选择共享同一个出牌阶段 ID；额外出牌阶段即使角色与轮数相同也有不同 ID。不用“轮数+角色”猜测，也不为跳过的阶段创建 ID。

无法确认自己的出牌阶段、缺少有效全场快照、只有过期快照或动作失败时，auto 隐藏全场，不计入未来阶段。setup、dead、over 状态也不自动附带全场；可主动 `observe` 查看。新游戏 epoch 会替换旧展示记录。

旧版本已打开的页面不会因更换 CLI 文件而自动更新内存投影；旧快照没有 phaseId 时不会自动显示全场，需主动 `observe`。新启动的客户端页面使用新投影。正常结束当前参与后再换版本启动，不为更新强行重开用户正在玩的对局。

## 展示记录

每个 CLI 会话目录使用独立 `display-feedback.json`，保存本局已显示的阶段 ID。只有 CLI 实际成功输出含全场概览的有效决策反馈后才更新，文本和 JSON 均适用；动作内部观察、`act --wait` 轮询和通知 worker 不会更新。原始游戏快照、证据、通知确认和日志游标保持完整。

展示记录不可读或不可写时，已确认的自己出牌阶段可能重新显示全场，不让展示状态故障中断游戏操作。并发读取命令可能都显示首次全场；它们不会因争夺展示机会而隐藏未展示的状态。这里沿用 CLI 现有 console 输出成功返回的判断，不提供外部接收者已阅读或异步管道已 flush 的确认。

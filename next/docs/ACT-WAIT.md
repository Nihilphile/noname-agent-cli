# 动作与等待合并

`act … --wait` 与 `play … --wait` 在同一次调用中提交操作，并在操作成功、仍处于 `running` 时等待下一次选择、本人死亡或对局结束。它不替玩家选择技能或目标。

```powershell
node bin/noname.cjs act c12 --at REV --wait --session play
node bin/noname.cjs act c12 fp3 --at REV --wait --wait-seconds 5 --state_hide --session play
node bin/noname.cjs act "c12 > fp3" --at REV --seconds 20 --wait --wait-seconds 5 --session play
node bin/noname.cjs play "无中 > 杀[fp3]" --at REV --seconds 30 --wait --wait-seconds 15 --session play --log-mode experimental
```

`--wait-seconds` 为动作成功后等待的上限，整数 1–60，默认 15 秒；只用于 `act --wait` 或 `play --wait`。既有 `--seconds` 仍是有限计划自己的执行预算，两者独立。等待不包含启动连接、动作执行和输出耗时，不能将它解释为整个命令的总耗时上限。

`play --wait` 的 `--interval-ms` 仍是每个底层动作后的动画间隔（默认 500ms），计入操作串执行预算。所有步骤都已证明成功后，将当前快照交给独立的等待阶段；已有选择立即返回。若最后一步自然进入下一阶段，也不把已成功的串误报为阶段切换暂停。中途跨阶段、未写明询问、未知提交依旧停止操作串；明确失败则按原有规则跳过本 `>` 组余项，继续下一 `|` 组。只要整串存在失败或暂停，尾随等待就标为 `skipped`；未执行项保留原有跳过记录或 `remaining`。

`play` 的 `steps/status/value/remaining` 描述操作串结果，`wait` 单独描述尾随等待。等待观察失败时 `ok=false`、`stateFresh=false`，但已完成的 `steps` 和 `value=1` 保留，`actionOutcome=completed` 明确动作已完成，不能重放。等待正常超时则保持 `ok=true`，并返回新确认的 running 快照。

观察每次读取最多等 1 秒；等待预算结束后再进行一次最多 1 秒的最终确认。读取超时属于观察失败，不能将旧 running 快照说成正常等待超时。

## 返回后如何继续

| 返回 | 含义和下一步 |
| --- | --- |
| 新选择 | 读取当前选项，用返回的新 revision 操作 |
| 本人死亡／对局结束 | 结束本次参与并复盘 |
| 等待超时，仍 running | 已提交的动作不重放；订阅已开则结束当前 Agent 轮次，等待通知，否则后续 observe 或 wait |
| 动作／组合失败 | 保留已完成步骤和原错误；不继续尾随等待，不自动补点 |
| 等待观察失败／页面更换 | 保留已确认的动作结果，旧快照不能当成当前状态；先核查连接和 observe，不能重试动作 |

动作已返回选择时立即结束，即使这只是选中一张牌后的同一选择；不会自动确认或越过它。已有组合仍遵守归属检查和意外选择停止规则。

## 日志和订阅

等待期间只观察，整个调用只在最终反馈处推进 act 日志游标；上次 act 后未消费的记录仍属于这次反馈。经典／压缩和实验流各自保留 epoch、序号及截断标记。每路最多保留 2000 条，长调用仍可能截断旧段；本功能没有无限历史保证。

已随 act 返回的最终选择按既有决策编号确认，不再因后台重复采样产生新通知。超时返回 running 后出现的新选择仍可通知。调用前已经进入宿主队列的旧消息无法撤回，收到仍须 observe 核验。

复合调用持有一次操作锁和一次连接。期间其他修改命令会报告忙；`notify status` 可查询。长操作阻止后台写心跳时，状态可显示 `operation_busy`，且明确后台健康尚未确认；不会伪造新心跳或把已退出的 worker 当成正常。

未加 `--wait` 的 act/play 保持原返回时机；play 原本在执行预算内等待结算的行为不变。默认日志为 compact，可显式选择 experimental；`--state_hide` 只隐藏常驻场面，不隐藏等待结论、选择、日志或结果。

验证范围见 [VALIDATION.md](VALIDATION.md)。

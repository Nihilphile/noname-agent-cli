# 扩展错误报告（experimental.7）

本版提供导入诊断和游戏会话的后台持续错误监听。基线为已发布的 `.6.0`，使用自行生成的故障扩展，以及用户提供的 Nihilphile 包的测试副本；测试使用独立客户端，不把故障包装入原游戏用户 profile。

```powershell
node bin/noname.cjs extension import "./example.zip" --target room --observe-seconds 3
node bin/noname.cjs extension reports
node bin/noname.cjs extension report REPORT_ID
node bin/noname.cjs extension watch status --session play
node bin/noname.cjs extension reports --session play
```

导入失败时，CLI 的错误 JSON 包含 `details.reportId` 和 `details.reportFile`。报告保存到工具目录的 `state/_extension-reports/`（开发工作树中为 `next/state/_extension-reports/`），临时客户端和 profile 清理后仍可读取。`extension report ID --json` 输出完整机器格式。

报告记录 ZIP 路径与 SHA-256（预检成功时）、扩展名、失败阶段、错误消息、堆栈、实际可提取的源码路径和行列，以及重复捕获渠道。没有获得源码位置时保留 null，不通过猜测补齐。读取报告不会重新安装或运行扩展。

`--observe-seconds 0..30` 控制成功重载后继续观察的秒数，默认 0。这个时间窗口捕获 window error、未处理的 Promise rejection，以及引擎报告的扩展加载错误；窗口中发现错误会阻止房间扩展发布。原生目标会在隔离预验证中使用同一观察窗口；若要求原客户端本身重载验证，另加 `--reload`。

`--observe-seconds` 只控制导入诊断。新建 `start`、`room create`、`room join` 的游戏会话另有独立 Node 后台进程，CLI 命令退出后仍监听整个会话。临时 ZIP 安装器不启动这个长期进程。监听 Runtime 未处理异常（包括 Promise rejection）、`console.error`、扩展加载错误和带错误文本的弹窗；因此能记录引擎捕获后通过控制台报告的技能异常。监听器不操作游戏、不回答弹窗、不自动修复或重开。

旧会话需要手动开启；普通单机默认 native，旧 isolated 会话加 `--client isolated`，房间会话自动路由：

```powershell
node bin/noname.cjs extension watch on --session play
node bin/noname.cjs extension watch off --session play
node bin/noname.cjs extension watch on --session test --client isolated
```

`watch status` 中 `armed` 表示已连接，`degraded` 表示连接或报告写入异常，`unavailable` 表示进程未运行，`unresponsive` 表示心跳过期。断线期间不能保证不漏报，恢复连接后会接收浏览器仍保留的错误；进程退出后需 `watch on` 重新启动。页面重载保持监听，关闭/离开会话后停止监听。每个客户端单独监控，房主与客机的错误分别保存。没有订阅外部通知。

局内报告的 `operation=extension_runtime`、`phase=runtime`，包含 session、客户端类型、会话启动时间和房间角色（如有）。可提取扩展路径时记录扩展名；只有引擎或匿名堆栈时标为 unknown，不能认定某个 ZIP 是根因。报告通过临时文件写入后原子发布，重连用原始事件时间和内容识别浏览器重放；同一错误再次发生仍会新增报告。

未触发的技能分支、扩展自行完全吞掉且未输出的异常、浏览器直接崩溃或监听断线期间丢失的事件不在保证范围内。引擎沙箱/eval 可能只提供匿名代码和引擎入口位置；保存真实堆栈，不虚构原始文件映射。

不收集局面、手牌、角色私有状态或完整配置；普通控制台对象不序列化。扩展自身错误消息仍可能包含其打印的业务内容，报告只保存在本地，不自动发送到任何外部服务。

第一轮实际实验已完成：语法、precontent、content、定时器和未处理 Promise 拒绝五类错误均有持久报告；损坏 ZIP 记录为 preflight。正常包不新增错误报告，临时客户端均清理，测试库恢复原样。

语法错误最初会触发确认弹窗，页面读取只得到超时；本版增加 CDP 控制台/异常/弹窗捕获，并仅在临时客户端取消确认，保存了原始 `SyntaxError`。真实原客户端不会自动取消该确认。没有浏览器提供的可靠行列时仍保持 null。

局内实测：完整复制用户的 Nihilphile 武将包，仅修改副本的 `module/guanyu.js`，给关羽添加测试技能。副本正常导入并通过 3 秒观察；实际独立斗地主中第一回合正常，第二次自己的 `phaseUseBegin` 抛错，CLI 启动进程已经退出，后台仍捕获了引擎 `console.error` 并保存报告。关停并重启监听未重复记录浏览器重放的错误；重载后仍 armed，停止游戏后后台退出。原包文件哈希保持一致。

此实测覆盖隔离游戏中的真实引擎结算，并在该测试 profile 打开 `ignore_error` 验证引擎捕获分支；没有向原用户客户端导入故障包，也没有完成多人全局兼容性或所有技能分支验收。公开版不附原始本机报告；验证范围见 [验证说明](VALIDATION.md)。

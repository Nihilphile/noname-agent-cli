# 同机联机房间（experimental.6.0）

当前支持同一台 Windows 电脑上的独立客户端联机。第一条使用路径是一个人类房主和两个 Agent 玩斗地主；也能用 Agent 担任房主。2v2 四席位已接通，但实测仍有待排查的停顿，见 [验证记录](VALIDATION.md)。

## 一个房间、三个席位

在 `包含 bin/noname.cjs 的工具目录` 执行：

```powershell
node bin/noname.cjs room create table --mode doudizhu --host human
node bin/noname.cjs room join table --session agent-a
node bin/noname.cjs room join table --session agent-b
node bin/noname.cjs room status table
node bin/noname.cjs room start table
```

`create` 打开独立房主窗口；人类通过该窗口选将、出牌和响应。等所有席位加入后使用 `room start` 开始选将。Agent 客机默认在后台运行，`room join ... --visible` 可显示客机窗口。Agent 客机不应同时交给人类代点。

房主默认 session 为 `table-host`，可用 `--session` 改名。`--host agent` 则由 Agent 控制房主，默认后台运行，可加 `--visible`。房间不会启动模型；各个 Agent 进程或任务由调用方运行，各自只拿到自己的 session 名。

每个 Agent 单独执行自己的命令，例如 Agent A：

```powershell
node bin/noname.cjs observe --session agent-a
node bin/noname.cjs wait --session agent-a --seconds 15
node bin/noname.cjs act OPTION --at REV --session agent-a
node bin/noname.cjs act OPTION --at REV --session agent-a --wait --wait-seconds 15
node bin/noname.cjs play "诸葛连弩 > 杀[目标ID]" --at REV --session agent-a --wait
```

`OPTION` 和 `REV` 必须来自该 session 最新的观察，不能照抄示例，也不能使用另一席位的 ID。牌、角色和 revision 都是客户端本地标识。选将也通过当时实际提供的按钮完成。

观察到 `choice` 时选择，`running` 时继续等待，`dead/over` 时停止操作。遇到 `disconnected` 或操作返回 `room_disconnected`，先检查 `room status`。页面重载期间可能暂时报告 `page_loading`，稍后观察即可；不要重放先前动作。人类席位的 `act` 会被拒绝。

多个 Agent 可同时等待、观察各自席位；不同客户端之间由原生网络协议传递选择。同一 session 的修改命令有独立操作锁。CLI 不应通过房主诊断数据替其他玩家决策。

## 生命周期

```powershell
node bin/noname.cjs room leave table --session agent-a
node bin/noname.cjs room close table
```

`leave` 只关闭指定客机；原生游戏可能随后托管该席位，不表示游戏结束。房主不能用 `leave/stop` 隐式结束所有人，必须明确 `room close`。关闭会停止本房间拥有的客户端与 HTTP 服务并清理其独立 profile；保留操作证据和房间记录。重复 close 不重复停止资源。

断线重连、刷新恢复原席位、局中换控制者、观战和再来一局尚无管理协议。当前可显式 close 后重新 create；离开不是暂停或存档。建房或加入失败会保留失败记录，先 close 清理再重建。

## 配置和限制

- 需要 Node.js 22+、当前无名杀懒人包安装，以及 Edge/Chromium。`--source` 可指定游戏 `resources/app`，但房主目前依赖其上两级的 Windows `无名杀.exe` 安装布局。客机可通过 `--browser` 指定浏览器。
- 房主首次启动会将 Electron 运行文件复制到本工作树 `next/state/_room-runtime/` 缓存，使用自有入口和 profile。游戏源码通过只读 HTTP 提供，不写原安装入口、规则、角色包或用户 profile。
- HTTP、CDP 和原生 WS 使用独立端口；原生 WS 只监听 `127.0.0.1`。当前不提供局域网其他电脑或公网连接入口。
- 独立配置启用 Nihilphile、标准武将、标准卡牌、军争卡牌，以及通过 `extension import ZIP --target room` 导入的扩展。每个房间固定创建时的扩展版本，更新只影响新房间；详见 [ZIP 扩展导入](EXTENSIONS.md)。不继承原用户的整套美化/配置恢复扩展。原安装资源仍是外部依赖，不随 CLI 分发。
- `--turn-seconds 600` 是原生选择超时参数，默认 600 秒，可设 10–3600；并不暂停整局或保证所有扩展技能都采用同一个时限。
- `--mode 2v2` 需要房主和三个客机；阵营与座次由原生分配，未实现指定组队。联机视图显示公开的己方/敌方关系，不输出队友手牌。
- 客机 `play` 支持与单机相同的原始操作、实体手牌封装、`>`、`|` 和 `--wait`。房主为远端选择提供稳定阶段标识，并在真正接纳对应实体牌时向该席位发送回执；`submission.confirmation=host_accepted` 表示提交已被房主接受。额外技能询问、换阶段、断线或回执未确认会停止管道，不重放动作。更新代码前已运行的房间需重建，以安装房主适配器。
- 客机没有完整的房主结算事件链。`effects` 和实验事件日志标注 `partial_online`，不能用于推断“没看到效果就是没发生”。提交回执不宣称伤害等效果已经完整结算。建议使用默认 compact 战报；`act` 成功仅证明该客户端接受了操作，最终结算需要继续观察。
- 席位绑定变化会隐藏局面并拒绝操作；不会沿用旧席位的手牌。这里是 CLI 的玩家视角约束，同一操作系统上的客户端并非彼此隔离的安全沙箱。

普通单机 `start/observe/play` 保留 `.5.1` 入口。房间 session 自动路由到其独立客户端，无需加 `--client isolated`，也不能强制切到 native。

房间管理默认输出简短文本，机器调用加 `--json`。自动通知沿用已有显式 `notify on` 入口；本轮没有执行通知投递验收，不能将其作为已验证的多任务调度保证。

`.7` 新房主和客机会话自动启动后台错误监听，命令退出后仍记录各自客户端的局内异常。用 `extension watch status --session NAME` 检查、`extension reports --session NAME` 查看报告；`room close/leave` 后监听停止。旧会话可 `extension watch on --session NAME` 开启。它只记录浏览器实际报告的错误，不保证识别全部技能缺陷；见 [扩展错误报告](EXTENSION-REPORTS.md)。

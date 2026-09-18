# noname-agent-cli

让外部 Agent 通过命令行参与本机无名杀对局，也支持一个人类与多个 Agent 在同一台电脑联机。工具提供玩家视角观察、操作串、压缩战报、ZIP 扩展导入和局内错误报告；模型由你自己的 Agent 环境提供。

当前版本：**1.3.0-experimental.9**（实验版）。[下载 Windows 使用包](https://github.com/Nihilphile/noname-agent-cli/releases/tag/v1.3.0-experimental.9)。

## 安装和第一次开局

需要 Windows、Node.js 22+，以及你自己安装的无名杀。当前实测覆盖子琪版 v1.11.3，以及本机官方发行目录的标准身份局；其他引擎版本尚未验证。隔离对局和本地房间还需要 Edge/Chrome，默认只启用官方标准内容，不要求安装 Nihilphile 或其他扩展。游戏本体、武将包和资源不随本工具分发。

下载发布 ZIP 后解压，进入包含 bin/noname.cjs 的目录；或获取源码：

```powershell
git clone https://github.com/Nihilphile/noname-agent-cli.git
cd noname-agent-cli/next
```

无需 npm install。将下面示例目录换成自己的安装目录（包含“无名杀.exe”或“noname.exe”，也接受其 resources/app）：

```powershell
node bin/noname.cjs setup --source "D:/Games/无名杀"
node bin/noname.cjs doctor
node bin/noname.cjs start --session demo --mode doudizhu --character caocao
node bin/noname.cjs observe --session demo
```

原客户端沿用游戏内已经启用的扩展。隔离客户端或本地房间需要显式声明从游戏目录加载的可选内容；列表用逗号分隔，例如：

```powershell
node bin/noname.cjs start --client isolated --session demo --mode identity --character nihil_guanyu --extensions Nihilphile --character-packs nihilphile
node bin/noname.cjs room create table --mode doudizhu --host human --extensions Nihilphile --character-packs nihilphile
```

setup 只需配置一次；以后启动、建房和导入扩展都会复用。目录包含中文或空格时加引号。原客户端默认显示窗口并使用原配置；若已运行且未开启调试，按诊断提示关闭后重新启动。关闭工具创建的客户端：

```powershell
node bin/noname.cjs stop --session demo
```

安装配置写在工具目录的 .noname-agent-installation.json，已被 Git 忽略。更换游戏目录时重新 setup；把工具发给朋友时使用发布 ZIP，让朋友单独 setup。[安装与目录配置](next/docs/INSTALLATION.md)。

## Agent 怎么操作

从 observe 返回值读取当前选择、合法选项和 revision，再执行；OPTION、REV、PLAYER 都是占位符：

```powershell
node bin/noname.cjs act OPTION --at REV --session demo --wait
node bin/noname.cjs play "青龙偃月刀 > 杀[PLAYER]" --at REV --session demo --wait
node bin/noname.cjs wait --seconds 15 --session demo
```

新选择出现时重新观察。操作串遇到需要新决策、阶段变化或无法确认提交时会停止；不会自动重放。机器调用可加 --json。可单独安装并手动调用 [noname-play Skill](skills/README.md)，让 Agent 按玩家视角使用这些命令。

发布 ZIP 也包含 `skills/noname-play`，可直接复制到 Agent 技能目录；固定武将测试的说明按需加载在 `references/test-room.md`。

## 人类与多个 Agent 同机联机

需要固定武将、斗地主身份或 2v2 队伍做对战测试时，使用独立的
[`test-room` 模块](next/docs/TEST-ROOM.md)：`test-room create NAME --lineup FILE`，
再执行 `test-room start NAME`；开局后仍使用各自 session 的玩家命令。

```powershell
node bin/noname.cjs room create table --mode doudizhu --host human
node bin/noname.cjs room join table --session agent-a
node bin/noname.cjs room join table --session agent-b
node bin/noname.cjs room start table
```

人类在房主窗口操作；两个 Agent 分别使用自己的 session 执行 observe/play/act/wait。CLI 不会自动启动模型。结束整桌用 room close table。当前限同一台电脑，2v2 仍有已知停顿限制。[房间使用说明](next/docs/ROOMS.md)。

官方版的 `noname.exe` 已能被自动识别并启动，但本机实测的房间服务器初始化仍停在 `ready=false`；因此本版只确认官方版独立对局可用，不声明官方版本地联机已经兼容。

## 人类游玩与整局复盘

```powershell
node bin/noname.cjs watch on --session human
# 人类在窗口中选将并游玩；后台持续保存实验战报
node bin/noname.cjs logs --all --session human
node bin/noname.cjs logs games --session human
node bin/noname.cjs logs --game GAME_ID --round 2 --session human
node bin/noname.cjs watch off --session human
```

`watch on` 打开或连接原客户端，由人类正常操作。新建游戏/房间会话也会自动记录。`logs --all` 默认返回实验模式文本，关窗后仍可读；用 `logs games` 获取历史局 ID。旧操作证据中已有的实验事件会自动合并恢复，缺段会明确显示；`--json` 才输出结构化数据。[观战与战报说明](next/docs/SPECTATING.md)。

## ZIP 扩展与错误报告

```powershell
node bin/noname.cjs extension import "./example.zip" --target room --observe-seconds 3
node bin/noname.cjs extension import "./example.zip" --target native --session demo
node bin/noname.cjs extension reports --session demo
node bin/noname.cjs extension report REPORT_ID
```

room 导入供之后的新房间使用；native 导入会修改原游戏扩展和配置，默认需要手动重载，立即重载需显式 --reload。已有同名扩展需 --replace。新会话会在后台持续捕捉可观测的局内异常，包括玩到一半才触发的错误；未触发或被扩展完全吞掉的异常无法保证捕获。报告保存在本地，可能包含本机路径和扩展输出，分享前请自行检查。

## 文档与验证

- [操作串](next/docs/PLAY.md)、[操作后等待](next/docs/ACT-WAIT.md)、[场面显示](next/docs/STATE-AUTO.md)
- [ZIP 导入](next/docs/EXTENSIONS.md)、[扩展错误报告](next/docs/EXTENSION-REPORTS.md)
- [验证范围与已知限制](next/docs/VALIDATION.md)、[本版更新](next/docs/RELEASE-experimental.9.md)

在 next 目录运行 npm test。部分引擎探针需要先配置匹配的游戏；没有安装时会跳过，不能把跳过视为游戏兼容性通过。

本项目采用 [GPL-3.0-only](LICENSE)。外部游戏与扩展遵循各自许可。公开仓库从整理后的源码建立独立历史，不包含开发机的个人配置、原始对局记录和历史发布附件。

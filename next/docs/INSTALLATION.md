# 安装目录配置

支持 Windows 上当前匹配的无名杀懒人包。无需把游戏复制进本仓库，也无需修改引擎文件。

在包含 bin/noname.cjs 的目录执行（示例路径请替换）：

```powershell
node bin/noname.cjs setup --source "D:/Games/无名杀"
node bin/noname.cjs doctor
node bin/noname.cjs doctor --client isolated
```

source 接受安装根目录或 resources/app。setup 验证 noname.js、index.html，并自动识别 `无名杀.exe`（子琪版）或 `noname.exe`（官方版）；其他可执行文件名可补 --executable，非标准浏览器位置可补 --browser。保存配置不启动游戏。

配置保存在工具根目录 .noname-agent-installation.json。没有配置时会给出安装提示，不回退到开发者电脑上的目录。优先级为命令参数、NONAME_SOURCE / NONAME_EXECUTABLE / NONAME_BROWSER 环境变量、本机配置。使用 NONAME_SOURCE 覆盖目录时，不会复用旧配置的 executable；默认根据新目录推导。

更换电脑或移动游戏后，重新运行 setup。配置错误时原配置不会被无效的新安装覆盖。若配置文件损坏，可直接再次 setup 修复。安装路径仅存在本地配置和运行记录中，不在公开发布包内。

首次使用普通 start 为原生客户端；--client isolated 使用独立配置和 Edge/Chrome。房间自动使用独立客户端。独立环境默认不要求或启用第三方扩展；需要从游戏目录加载扩展时，显式提供 `--extensions 扩展目录名`，并用 `--character-packs` / `--card-packs` 声明它注册的包 ID。多个值用逗号分隔。原生客户端仍沿用游戏内配置。

把工具转交朋友时，使用发布 ZIP 或干净源码；不要附带 state、state-native、安装配置、显示配置或原始错误报告。它们可能包含个人目录、局面或客户端连接信息。

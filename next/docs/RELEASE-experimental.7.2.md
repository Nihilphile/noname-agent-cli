# 1.3.0-experimental.7.2

- 独立对局和本地房间不再隐式依赖 Nihilphile。默认只启用官方标准内容；游戏目录已有扩展通过 `--extensions`、`--character-packs` 和 `--card-packs` 显式加入。
- 新增通用内容 profile，房主、客机和导入扩展共享同一条配置边界；原生客户端仍沿用用户自己的游戏配置。
- Windows 安装自动识别子琪版 `无名杀.exe` 和官方版 `noname.exe`，显式 `--executable` 仍具有最高优先级。
- 清除角色查询结果中的 Nihilphile 专用测试标记，并更新安装、房间、扩展和验收文档。

自动化测试 563 项全部通过。官方目录实测包括无第三方扩展的曹操身份局，以及显式启用 Nihilphile 后选择 `nihil_guanyu`。官方 `noname.exe` 的 doctor、复制和启动均通过；本地房间随后在服务器初始化处停于 `ready=false`，因此本版不声明官方版联机兼容。

这是 Windows 实验版。游戏本体、扩展和模型均不随工具分发；完整范围与限制见 [VALIDATION.md](VALIDATION.md)。

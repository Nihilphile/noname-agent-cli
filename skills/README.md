# noname-play Skill

[技能正文](noname-play/SKILL.md) 描述如何通过本工具观察、操作和复盘对局，不包含模型或游戏文件。

从 GitHub 安装时使用仓库 `Nihilphile/noname-agent-cli` 下的 `skills/noname-play` 目录；也可以把整个 `noname-play` 文件夹复制到 Agent 环境的技能目录。该 Skill 默认仅手动调用，不会因普通游戏讨论自动触发。

调用 `$noname-play` 时告诉 Agent 工具目录、session 名，以及要接手现有对局还是启动新局。技能不自动安装 CLI、不自动配置游戏目录，也不会因为读取技能就启动对局。

源码工具入口在 next/bin/noname.cjs；发布 ZIP 的入口在 bin/noname.cjs。先按主 README 完成 setup 和 doctor。

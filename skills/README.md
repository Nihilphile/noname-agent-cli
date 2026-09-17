# noname-play

[技能正文](noname-play/SKILL.md) 描述如何通过本工具观察、操作和复盘对局，不包含模型或游戏文件。

将 noname-play 文件夹放入你所用 Agent 环境的技能目录，并按该环境的方式手动调用。调用时告诉 Agent 本工具的实际目录和 session 名。技能不自动安装 CLI、不自动配置游戏目录，也不会因为读取技能就启动对局。

源码工具入口在 next/bin/noname.cjs；发布 ZIP 的入口在 bin/noname.cjs。先按主 README 完成 setup 和 doctor。

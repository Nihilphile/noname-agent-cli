# ZIP 扩展快捷导入（experimental.7）

在 `包含 bin/noname.cjs 的工具目录` 执行。工具读取本地 ZIP，调用游戏菜单使用的 `game.importExtension(ArrayBuffer, callback)`，完成文件写入、登记和启用。无需在菜单中选择文件。`.7` 导入失败会保存 [错误报告](EXTENSION-REPORTS.md)，可加 `--observe-seconds 3` 观察延迟错误。

## 本地联机房间

```powershell
node bin/noname.cjs extension import "./example.zip" --target room
node bin/noname.cjs extension list
node bin/noname.cjs room create table --host human
node bin/noname.cjs room join table --session agent-a
node bin/noname.cjs room join table --session agent-b
```

导入先在临时客户端验证，文件内容、持久配置和重载加载均通过后，才发布到本工具的 `next/state/_extensions/`。原游戏的扩展目录和用户 profile 不参与房间导入。

新房间默认包含库内所有已导入扩展以及原有 Nihilphile。房主与客机分别登记、启用相同版本；`room status --json` 的 `extensions` 列出版本 SHA-256。客户端的 HTTP 资源和房主的 Node 文件读取都使用该房间固定的扩展目录，缺少的文件不会回退到原安装的旧版。

同名更新需明确加 `--replace`：

```powershell
node bin/noname.cjs extension import "./example-v2.zip" --target room --replace
```

更新只影响之后新建的房间。已有房间及之后加入它的客机继续使用旧版；`room close` 清理 profile，但保留扩展库。当前没有局中热更新、库管理卸载或自动清理旧版本命令。

## 原游戏客户端

```powershell
node bin/noname.cjs extension import "./example.zip" --target native --session play
```

使用指定 native session；尚未运行时按现有 native 生命周期启动客户端。已有客户端需要具备调试连接，可使用 `--attach`；未开启调试时沿用 `requires_debug_restart` 提示。房间 session 不能作为 native 导入目标。

该入口实际修改原安装的 `extension/扩展名/` 和原客户端配置。默认不重载：返回 `installed=true, persisted=true, loaded=false, restartRequired=true`，之后手动重载游戏即可生效。`loaded=false` 在这里表示尚未验证重载后的加载结果。

希望立即重载可明确指定：

```powershell
node bin/noname.cjs extension import "./example.zip" --target native --session play --reload
```

重载会中断当前页面/对局。只有新页面完成入口加载、扩展启用且没有检测到加载错误，才返回 `loaded=true`。关闭窗口再打开需要沿用该原客户端的安装与 profile。

原安装已有同名目录或登记时，必须加 `--replace`。导入前保存原目录文件及相关配置快照，输出 `backup` 路径。游戏的原生覆盖行为会清除旧扩展设置，并可能保留 ZIP 未包含的旧文件；备份不是所有扩展私有数据库的完整快照。

原生导入不是事务。若写入或重载验证失败，命令报错并给出备份位置，不自动重试，也不声称已经回滚；应检查具体失败原因与原客户端状态。

## 格式、包清单与限制

- ZIP 根目录必须有 `extension.js`。传统 `game.import('extension', ...)` 入口可无 `info.json`；ES module 入口需要根目录 `info.json`，其中包含有效的 `name`。
- 支持 UTF-8 路径、中文扩展名、子目录资源，以及 Store/Deflate 压缩。拒绝路径越界、Windows 保留名、同名大小写冲突、文件/目录冲突、符号链接、加密、多卷、ZIP64 和 CRC 错误。
- 当前上限为 ZIP 64 MiB、解压后合计 128 MiB、单文件 32 MiB、10,000 条目；更大的扩展包暂不支持快捷导入。
- 房间导入将“无扩展时的联机包列表”与“单独加载该扩展后的列表”比较，记录新增武将包/卡牌包 ID，不通过扩展名猜测。只修改已有包或需要额外内置包时，可显式补充 `--character-packs id1,id2 --card-packs id3`；这些 ID 必须已被实际加载。
- 房间导入验证的是独立浏览器客户端。原游戏导入另用独立 Electron 验证。依赖其他扩展、外部文件、特殊配置或仅支持特定模式的包，可能无法通过独立验证；应按错误处理，不会通过放开全部扩展绕过。
- 加载成功不等于扩展的每个技能都兼容联机。实际对局仍由扩展自身与原生引擎负责。本次不改变 `.5.2` 已记录的 2v2 停顿和事件日志覆盖限制。

安装脚本属于可执行扩展代码；“隔离客户端”用于隔离配置和工具管理的文件路径，并非不可信代码沙箱。

机器调用加 `--json`。实测范围与证据见 [.6.0 交付记录](VALIDATION.md)。

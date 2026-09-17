# 会话与内容配置

只在用户要求启动、重开、选择客户端、启用可选内容或创建房间时读取。普通 `observe → play/act → wait` 循环不需要重复加载。

## 先确认工具能力

在用户指定的工具目录运行：

```powershell
node bin/noname.cjs help
node bin/noname.cjs doctor
```

以当前 `help` 为准。`setup` 能自动识别 Windows 安装中的 `无名杀.exe` 或 `noname.exe`；路径仍有问题时让用户按工具 README 完成安装配置，不猜测或修改游戏入口。

## 接手还是开新局

- 用户给出已有 session：先 `observe --detail --session NAME`，不要重新启动。
- 用户明确要求新局：使用新的 session 名和确切模式、武将 ID。
- 武将 ID 不存在时保持失败；在仍运行的会话中用 `characters QUERY --session NAME` 查实际 ID，不自动换成别的武将。
- `restart` 会放弃当前参与并按保存或显式提供的参数重开，不会把正在进行的对局转换模式。

## 选择客户端

原生客户端是默认值，使用原游戏 profile 中已经启用的扩展和包：

```powershell
node bin/noname.cjs start --session NAME --mode identity --character caocao
```

隔离客户端使用独立 profile，默认只要求官方标准内容，适合不影响原配置的身份局或斗地主：

```powershell
node bin/noname.cjs start --client isolated --session NAME --mode identity --character caocao
```

本地 2v2 使用原生客户端或 `room` 工作流；不要给普通 isolated start 指定 2v2。

## 可选扩展和包

原生客户端直接使用游戏内配置，不附加内容参数。隔离客户端需要从游戏目录加载可选内容时，同时声明扩展目录名和它注册的包 ID：

```powershell
node bin/noname.cjs start --client isolated --session NAME --mode identity --character CHARACTER_ID --extensions EXTENSION_FOLDER --character-packs PACK_ID
```

卡牌包另加 `--card-packs CARD_PACK_ID`；多个值使用逗号分隔。扩展目录名、武将包 ID 和卡牌包 ID 是三类不同标识，不从名称互相猜测。只有用户要求或目标武将确实属于该包时才启用可选内容。

重开 isolated 会话时，未重新提供的内容配置沿用该会话已保存的意图；显式参数替换对应列表。

## 房间

已加入的房间 session 与普通会话使用相同的 `observe/play/act/wait`。只有用户明确要求管理房间时才调用 `room create/join/start/close`，并先读工具目录的 `docs/ROOMS.md`。房间创建失败时保留原错误，执行 `room close NAME` 清理，不改用另一客户端偷偷重试。

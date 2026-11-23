# 启用 Devbar 始终包含 Agent 与终端能力

Status: implemented
Translation: current

[English](2026-09-23-devbar-agent-access-merged.md)

部分替代 [Devframe Hub UI 决策](../feature/2026-09-16-devbar-hub-ui.zh.md)
中的二级开关部分。

## 摘要

Devbar Hub 此前启动时不带 Agent 侧工具；需要第二个“Agent 与终端权限”开关来重启
Hub、加入聚合 MCP endpoint 和 Terminals add-on。实际上打开 Devbar 就是为了用这些
工具，因此额外的 gate 只增加了一次 Hub 重启和一个隐藏的第三状态，却没有改变谁能
触达该能力。现在启用 Devbar 会始终启动带 MCP 和 Terminals 的 Hub，二级控件及其
`agentAccess` IPC 字段一并移除。loopback 信任边界、每进程 token 和 Terminals
“禁止任意命令”的限制不变；高权限的交互式 shell 现在只跟随 Devbar 开关，这是
有意接受的取舍。

## 决策与证据

`DevbarControlInput` 移除 `agentAccess`；Settings renderer 与 main 之间的线协议
现在是 `{ enabled }`。`startDevbarDevframe` 始终挂载
`plugin-terminals` 和 Hub 的聚合 `mcp` endpoint，能力集不再随启动后变化，
`setDevbarControl` 也不再因为标志位变化而重启 Hub。设置页移除二级开关，并在 Hub
运行时直接显示 Agent 连接端点。停止 Devbar 仍会关闭 listener 并移除两项能力。

同一次清理把 `warmupEnabled` 从 devbar 控制消息中拆出，改用独立的
`getWindowWarmup`/`setWindowWarmup` IPC。辅助窗口预热与诊断无关——它当时只是
复用了唯一的开发者控制通道，而每次 `setDevbarControl` 都会无条件重载主窗口，
导致拨预热开关也会无谓地重载应用。预热池的指标仍汇入 Devbar 快照
（`warmPool`），这是耦合中合理的一半：Devbar 依然是它的观测面。

被否决的备选是“保留开关但默认打开”：一个没人会去关的默认开启开关仍然暗示着
更安全的默认姿态，却为“本来就是开 Devbar 的目的”的能力多保留了一个配置状态
和一条 Hub 重启路径。合并的真实代价是“打开 Devbar”会立即暴露一个 loopback MCP
endpoint，其 Terminals add-on 向受信调用方授予交互式本地 shell 会话；旧设计允许
只跑诊断。该暴露仍处在不变的边界内——仅 loopback 绑定、Origin 允许列表加
opaque Origin 的每进程 token、`allowArbitraryCommands: false`，以及 Agent 写入的
Lody MCP entry 仍需在受信 UI/CLI 审核——因此唯一扩大的面只是本地用户少点了一次
同意。

## 验证

`parseDevbarControlInput` 与 `initialDevbarControl` 测试已更新；启用后 Hub 的
MCP/Terminals 面与此前是同一份组合代码，未新增运行时验证。当前保证见
[Desktop 性能栏 Spec](../../../../specs/desktop-devbar.zh.md)。

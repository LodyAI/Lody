# 保持 stdio MCP 应用运行时存活

Status: implemented
Translation: current

[English](2026-10-14-mcp-stdio-lifetime.md)

## 摘要

stdio MCP 命令在连接完成后立即返回，CLI 因此关闭共用应用运行时，而 transport 仍在接收请求。
后续创建工作区可能报 `Presence application owner unavailable`。现在使用有 Scope 的 Effect
连接，等待 transport、输入结束或进程信号后才释放 SDK 订阅。本次只修复服务入口生命周期，
不改变任意工具处理 Promise 的取消机制或 HTTP 的所有权。

## 原因和职责

内部子命令已经经过应用入口的 Presence 绑定。缺陷是提前释放，而非独立进程缺少初始化。
这是对 [工作区 Presence 所有者](../architecture/2026-10-12-effect-workspace-presence.zh.md)
消费者生命周期的修复。`connect()` 只表示监听已安装，不表示服务结束。

- 触发：内部 stdio 命令创建新的 SDK server 和连接。
- 所有者：命令的 Effect Layer Scope 管理 transport 和事件订阅；外层 CLI 继续管理共用应用运行时。
- 取消：stdin EOF/close、SDK close、SIGINT/SIGTERM 结束等待；流错误使其失败。
  Fiber 中断同样释放订阅。SDK close 会触发请求取消信号，不宣称任意 Promise 工具已结束或完成迁移。
- 交接：先订阅再启动 SDK。锁定版本 SDK 的 stdio 启停虽返回 Promise，实际同步安装、移除监听，
  没有网络或 drain 等待。仅短暂的启动安装不可中断，避免释放之后才完成获取。
  保留 SDK 关闭回调及请求取消行为。
- 恢复：每次命令创建新连接。启动、输入错误和清理缺陷的组合 Cause 通过命令 AggregateError 保留。
  不自动重试或重新绑定应用所有者。

用 Promise 等待 EOF 也能修复直接症状；采用 Effect Scope 和 Deferred 是为了明确中断、事件所有权
和错误组合，同时不迁移工具实现或增加另一个应用运行时。

## 验证

十项确定性测试使用真实 SDK 和内存 Node 流，覆盖协议握手及工具借用真实应用运行时、EOF、两种退出
信号、Fiber 中断、部分启动失败、输入错误、SDK 关闭、在途工具收到取消、已销毁输入，以及启动与清理
组合失败。不使用网络、真实休眠或生产会话。移除连接后的 Deferred 等待，握手回归测试立即报
“MCP command ended before the client finished”；消融结束后已恢复等待。

生命周期与原有 MCP 套件共 60 项通过。工作区类型检查、普通和 Effect lint、格式化、文档检查
（零错误，没有 SHA 保护主题）、i18n 及七项边界检查通过。全量 `pnpm check` 在 CLI 测试阶段停止：
4,196 通过、1 失败、4 跳过。未修改的递归原生 SSH 子模块凭据测试报 `context_unreadable`，
单独重跑同样失败（其余 23 项通过）。不宣称全仓检查通过或已验证部署中的 nightly。
原生服务边界由作用域规则与行为测试约束，没有专用静态执行检查。任意工具 Promise 的所有权仍不在本单元内。

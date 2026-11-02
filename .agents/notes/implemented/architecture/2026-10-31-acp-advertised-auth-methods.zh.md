# 提前展示 ACP agent 公布的登录方式

Status: implemented
Translation: current

[English](2026-10-31-acp-advertised-auth-methods.md)

## 摘要

ACP agent 会在 `initialize` 响应里公布登录方式，但 Lody 过去只在下一次登录动作里读取这份列表，界面上因此只有一个「登录」按钮，用户要点进去之后才知道某个 Provider 支持多种方式（浏览器、设备码、API key）。现在能力探测会把公布的方法记到 Provider 的能力行上，账户面板在 Provider 设置和会话里的 `acp_auth_required` 卡片中直接把它们列为登录入口，`machine/acp-authenticate start` 也会带上用户选中的 `methodId`。`initialize` 公布的是「支持哪些登录方式」，与当前凭证是否有效无关，所以面板不再等待实时 `authRequired` 信号；代价是某个 Provider 从未记录过方法时，面板首次渲染要跑一次能力探测。

## 问题

`agent-client.ts` 在每次 `initialize` 时缓存 `initResponse.authMethods`，但唯一的读取方是 `authenticateProtocolDrivenAcp`：只有一个方法时自动选择，多个方法时才发 `auth-methods` 进度并弹出选择器。两条路径都发生在用户已经发起登录之后，界面无法提前展示列表。设置对话框还把 registry / custom / Devin 的整个账户面板卡在实时 `authRequired` 上，`usesAcpProtocolAuthentication` 的注释正是这条规则。

## 决策

- `fetchAcpCapabilities` 随探测结果返回 `client.getAuthMethods()`。
- `AcpCapabilityCacheEntry.authMethods` 只为 agent 驱动（registry、custom、Devin）的 Provider 记录这份摘要列表。`undefined` 表示还没有探测问过，`[]` 表示问过且对方没有公布任何方法——这个区分避免面板反复探测。
- 能力刷新（包括命中持久缓存的分支）返回同一份列表，探测完成后界面立即收敛。没有询问 agent 的能力写入（会话建立后的能力更新）在同一启动版本下保留已记录的方法；启动版本变化时会丢弃，交给发现流程重新探测。
- `AcpAuthenticationPanel` 优先读能力行，否则每个目标每次挂载最多跑一次能力刷新；它把 agent 驱动的方法渲染成可点击的行来替代单个按钮，设置里的账户区与会话里的登录提示共用这一套。
- `machine/acp-authenticate start` 增加可选 `methodId`，由新的 `acpAuthenticationMethodSelection` 协议能力（v1）把关，因为请求 schema 是严格模式。daemon 会重新读取实际公布的列表，只有 agent 仍然公布该 id 时才采用；否则保留原有的单方法自动选择/自身选择器行为。
- 设置对话框对协议认证的 Provider 不再要求 `authRequired` 才显示账户面板；`authRequired` 只决定提示文案。

考虑过的替代方案：

- **独立的发现 RPC**：不能复用现有的 spawn + initialize + 持久化，新增的严格消息还要自带能力与错误面。
- **只在渲染进程缓存**：更省，但重启后会话里的登录提示没有列表，而且这份探测结果本来就归 Fleet 文档所有。
- **自动选第一个方法**：恰好隐藏了这次改动要展示的选择，还可能启动用户没要求的登录。

## 证据与限制

行为覆盖：`apps/cli/src/agent/acp-authentication.test.ts` 覆盖提前选中的方法与过期选择；`apps/cli/src/agent/acp-capabilities.test.ts` 覆盖返回公布的方法；`packages/shared/tests/message-schemas.test.ts` 覆盖 `methodId` 与缓存里的 `authMethods`；`packages/components/tests/use-machine-acp-authentication.test.tsx` 覆盖把选择带给 start 请求。验证限制：编写环境缺少 ACP 扩展子模块且 Node 版本低于仓库下限，这些套件均未实际执行，合并前仍需跑 `pnpm typecheck` 与各包测试。没有自动化测试真的为「发现」拉起 agent。

限制：某个协议 Provider 的账户面板第一次渲染且没有记录过方法时，会跑一次探测（可能包含托管运行时下载）。过期的缓存列表可能提供 agent 已经移除的方法，daemon 会回退而不是报错。旧版渲染进程解析不了带 `authMethods` 的新能力对象，桌面端与 daemon 应一起升级。

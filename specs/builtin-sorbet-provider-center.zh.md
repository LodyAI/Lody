# 内置 Sorbet 与 Provider Center

Status: draft
Translation: current

[English](builtin-sorbet-provider-center.md)

## 场景

用户在某台 Machine 上添加 Agent 时，可以选择由 Lody 内置的 Sorbet。Sorbet 表单直接展示这台
Machine 的连接设置，不再额外显示一个命名为 Provider Center 的嵌套标题。新 Machine 默认没有
自定义 Provider，也不会自行猜测连接。用户可以登录内置 Sorbet runtime 声明的任意订阅 OAuth
Provider——目前包括 Codex、Claude、GitHub Copilot、Kimi Code 和 xAI；也可以添加兼容 OpenAI
或 Anthropic 协议的自定义 Provider。

Codex 是推荐连接；如果它是第一个可用连接，就成为默认连接。Claude OAuth 在用户主动启用前
保持关闭；其他已声明的订阅连接可以直接登录。用户可以显式选择任意已连接的 Provider。选中的
连接为新的 Sorbet Session 提供默认模型。

## 职责

Lody 负责锁定内置 Sorbet revision、Agent 创建流程、Machine 路由、secret 传输、进程监管，以及
为新 Session 解析连接。Sorbet 负责 Provider 定义、凭据、模型、Session 执行、Journal，以及
Session 内记录的实际 Provider 与模型。

Provider Center 状态归执行任务的 Machine 所有，存放在 Lody 的 Sorbet 数据目录下。非敏感连接
metadata 可以跨越 Machine RPC。OAuth 继续走 Sorbet 的 ACP authentication method。API key 使用
目标 Machine 提供的一次性公钥和加密信封；它不得进入 Agent config、Machine Flock row、Loro
文档、prompt、Journal、保留的 progress、命令行参数或日志。目标 CLI 解密后通过 Sorbet
credential store 写入，只返回 metadata。

Machine 发布 `sorbetProviderCenter` protocol version 1。客户端必须检查这个 capability，不能根据
CLI 版本或自身 UI 中是否有 Sorbet 来推断支持。旧 Machine 显示升级或重启要求，不能展示一个
必然失败的配置操作。

## 连接行为

- 新 Machine 默认启用并推荐 Codex OAuth。
- 新 Machine 默认关闭 Claude OAuth，必须由用户明确启用。
- 其他订阅 OAuth 连接来自 Sorbet 的 Provider metadata，而不是 Lody 维护的另一份 allowlist。
  当前内置 runtime 除 Codex 和 Claude 外还声明 GitHub Copilot、Kimi Code 与 xAI。
- 新 Machine 默认没有自定义 Provider。新增时必须提供名称、HTTP(S) endpoint、协议、至少一个
  模型和 API key，之后才能使用。
- 断开或退出只作用于一个 Provider，不能清除其他 Sorbet 凭据。
- 仍有已保存 Sorbet Session 或 approval reviewer 引用某个自定义 Provider 时，删除必须被拒绝。
- “用于新 Session”只改变 Machine 默认值，不改变正在运行的 Session。

已保存默认连接失效后，解析顺序依次为：可用的 Codex OAuth、其他已经连接且启用的订阅 OAuth、
可用的自定义 Provider。解析过程绝不能自行启用 Claude。没有可用连接时，Session 创建停留在
Provider 设置，不能暗中切换 Provider 或降低认证要求。

每个 Sorbet worker 启动时接收解析后的默认模型。Sorbet 把实际 Provider 和模型记录在 Session
metadata 中。加载或恢复 Session 时使用已记录的值，因此之后修改 Machine 默认值只影响新
Session。Provider 故障绝不触发自动跨 Provider 重试；用户必须先作出明确并持久化的选择，后续
工作才能使用另一个 Provider。

## 运行时与持久性

每个活跃的 Lody Session 启动一个 Sorbet ACP worker，不设置 Machine 级常驻 Sorbet host。Lody
通过单一 control queue 串行执行 Provider Center 变更，每次 control 操作都调用 Sorbet 公共的
Provider 与 credential 边界。Session worker 在进程启动时读取 Provider 定义；正在运行或恢复的
Session 保持已经固定的 Provider snapshot。

内置 control entry 与 ACP entry 都使用 `<lody-data>/agents/sorbet`，并遵守 `LODY_DATA_DIR`。
Provider 选择以 owner-only 权限原子写入；credential mutation 使用 Sorbet 的跨进程 lease。
API key 加密接收方只使用一次、数量有上限，客户端未完成提交时会过期。

目标 Machine 在启动 Sorbet 前，把环境或系统 HTTP(S) 代理解析为标准代理变量。Sorbet 在自身
可执行入口安装支持代理的 Node 全局 dispatcher，因此 OAuth code exchange、token refresh 和
Provider 模型请求都会一致地遵守 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 与 `NO_PROXY`。

交互式 OAuth 启动后，Sorbet 可能持续等待认证方式选择、URL 授权、表单响应或浏览器 code。与它
对应的提交或取消消息必须直接到达仍存活的请求，不能排在 Machine control queue 的启动操作后面；
否则两个操作会互相等待，认证永远无法完成。Lody 专用认证 client 会声明版本化的
`lody.credentialForm` capability，因为表单响应走一次性加密的 Machine RPC 路径。只有看到这项
capability，Sorbet 才会用表单传递 `secret` 与 `manual_code` prompt。Sorbet 会先等待 URL 授权，
再请求 Pi 的备用手动 code；Lody 会在显示该表单时继续保留授权链接。

## 证据

- `packages/shared/src/sorbet-provider-center.ts`
- `packages/shared/src/machine-protocol-capabilities.ts`
- `packages/loro-streams-rpc/src/rpc.ts`
- `packages/loro-streams-rpc/src/machine-rpc-server.ts`
- `apps/cli/src/agent/sorbet-provider-center.ts`
- `apps/cli/src/agent/sorbet-provider-preferences.ts`
- `apps/cli/src/lib/machine-runtime.ts`
- `apps/cli/src/sorbet-provider-control-entry.ts`
- `apps/cli/tests/machine-runtime-acp-authentication.test.ts`
- `packages/components/src/components/settings/sorbet-provider-center.tsx`
- `packages/components/tests/sorbet-provider-center.test.tsx`
- `packages/components/src/components/settings/agent-config-dialog.tsx`
- `apps/cli/scripts/check-sorbet-runtime.mjs`
- `packages/sorbet/packages/node-agent/src/network/http-proxy.ts`
- `packages/sorbet/packages/node-agent/tests/http-proxy.test.ts`

已执行验证：shared、Streams RPC、CLI 与 components type check；Streams RPC 与 Provider
Center 组件测试；打包后的 Sorbet lifecycle 与 Provider Center smoke check（包括实际执行到
Codex OAuth 第一个登录提示）；以及交互式认证队列回归测试。在 Darwin 上，最终 CLI bundle
还会连接本地虚拟 Provider，完成模型驱动的并行 Read 与 Bash Tool，应用 thinking 与 permission
配置，在 worker `SIGKILL` 后恢复 durable Session，并从已提交 turn 创建独立 fork。虚拟 Provider
不会覆盖真实 OAuth 账户、付费模型请求、已安装桌面 UI、打包后的 Windows/Linux runtime 或完整的
外部副作用故障矩阵；这些仍是独立的生产门槛。

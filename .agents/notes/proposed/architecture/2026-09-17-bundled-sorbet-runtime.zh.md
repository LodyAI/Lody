# 将 Sorbet 作为 Lody 内置 Agent 打包

Status: proposed
Translation: current

[English](2026-09-17-bundled-sorbet-runtime.md)

## 摘要

Lody 无需引入机器级常驻 Sorbet host 也能接入 Sorbet，因为 Sorbet 已经实现 ACP 会话持久化，
也实现了按 turn 分叉、转向、目标、压缩、子 Agent、历史和用量所需的 Lody 扩展。建议由
Lody 版本锁定 Sorbet 源码，构建内置的 `sorbet-acp` 入口，并为每个活跃的 Lody Session
启动一个 worker，同时继续由 Lody 掌握对话记录、协作、身份和恢复契约。剩余工作集中在
跨进程状态归属、可信凭据配置、各平台沙箱打包，以及崩溃与幂等测试。在这些门槛通过前，
不能把 Sorbet 当作可用于生产的内置 Agent；不完整的接入不能删除或暗中弱化 Lody 的现有能力。

## 决策背景

本文记录 Lody-Sorbet 接入调查形成的工作结论和原型状态。它不表示运行时已经可以用于生产，也不是已经
批准的 Spec。

- Sorbet 随 Lody 安装包作为 builtin 交付。用户不单独下载或更新 Sorbet release。
- Lody 负责锁定 Sorbet revision、打包、升级、回滚、进程监管和产品行为；Sorbet 负责 Agent
  runtime 和执行语义。
- 每个活跃 Lody Session 拥有一个 Sorbet ACP worker，不设置机器级常驻 Sorbet host。
- 恢复时绝不重试无法确认是否已经送达的外部副作用。这类副作用必须显示为 `unknown`，并等待
  显式恢复或用户发起新的操作。
- 接入不能牺牲用户可见的 Lody 行为。能力门控可以表达 Sorbet 或 Provider 本来就没有某项能力，
  但不能用来隐藏接入造成的回退。
- 新的 Sorbet 配置默认没有自定义 Provider。存在有效 Codex OAuth 时优先把它作为默认连接。
  Claude OAuth 默认关闭，只有用户明确启用后才能选择。用户可以在已启用的 OAuth 连接和
  自定义 Provider 之间显式切换。
- 连接选择只决定新 Session 的默认值。运行中或恢复的 Session 继续固定使用已经记录的连接和
  模型，直到用户明确修改；Provider 失败绝不触发暗中的跨 Provider 重试。

调查基线：

- Lody：`fb249326d555623208a5a281383df445839d660e`。
- Sorbet：`a7dee4dffb746164aeea6dfda50a88e98ac169a7`。
- 构建所需 workspace 包后，Sorbet ACP 兼容与一致性测试全部通过：5 个文件、36 个测试；
  单独生成的兼容矩阵测试也通过。

当前原型锁定 Sorbet `93e7931a1b096c07a3097bbe0aa2c81746f9c49d`。该版本也包含下文所述
的跨进程 Journal writer lease 与 credential mutation lease，并把打包的 Windows SRT helper
路径显式传给 sandbox readiness 检查。

## 原型实现状态

第一段面向用户的接入流程已经可以在 Lody checkout 中运行并进行手动测试，但它本身还没有满足
下文的全部生产门槛：

- Lody 以 submodule 锁定 Sorbet，并把 Sorbet 自己的 pnpm workspace 排除在 Lody workspace
  之外。CLI 准备步骤会先校验精确 revision，再按依赖顺序构建 Sorbet。
- Vite 与开发 bundler 会生成 `sorbet/dist/stdio-cli.js` 和相邻的
  `filesystem-worker.js`。release build 会复制 sandbox-runtime 的 Linux/Windows helper，并写入
  worker 所需的 ESM package 边界。Sorbet CLI 入口通过静态 import 注册 Pi 的 bundled OAuth
  loader，确保各 OAuth 实现进入独立 bundle，不会留下运行时无法解析的 import。
- Builtin 启动解析通过 `process.execPath` 启动内置入口，用 Sorbet revision 标识 capability cache，
  并明确使用 `<lody-data>/agents/sorbet`。独立 CLI 的 Node 版本低于 22.19 时，只拒绝 Sorbet
  启动，不改变其他 Lody Agent 的 Node 版本契约。
- Lody 会在启动 worker 前解析目标 Machine 的环境代理或系统 HTTP(S) 代理。Sorbet 的可执行
  组合入口会安装支持代理的全局 dispatcher，让 Pi 的原生 `fetch` 在 OAuth code exchange、
  refresh 和 Provider 请求中使用同一路由，同时保留 `NO_PROXY` 行为。
- Sorbet 已加入 builtin 校验、标题策略和 ACP 协议认证分流，并出现在 Agent 选择器中。它的 Agent
  表单包含 Machine 级 Provider Center，并通过版本化的 `sorbetProviderCenter` protocol
  capability 进行门控。
- Provider Center 推荐 Codex OAuth；启用 Claude OAuth 前要求用户明确操作；支持自定义
  Provider 的新增、编辑、删除和按 Provider 退出；默认值变更只影响新 Session。API key 使用
  一次性加密 Machine RPC，通过 Sorbet credential 边界写入，不进入 Loro 或 Agent config。
- Lody 专用认证 client 会声明一项版本化的 credential-form 扩展，表单响应同样走一次性加密的
  Machine RPC。对其他 client，Sorbet 仍遵守 ACP 默认禁止 credential form 的规则；只有看到这项
  扩展时，才把 Pi 的 `secret` 与 `manual_code` prompt 标记为 secret。浏览器 URL 授权会先于备用
  表单完成，避免两个认证交互互相抢占。
- release-build smoke check 会从空数据目录启动最终打包入口，完成 ACP 协商，验证 Codex 与
  Anthropic OAuth 声明，实际启动 Codex OAuth，并执行到 Pi 的 credential-safe 手动 code 提示。
  这样会执行最终 bundle 中的 OAuth module 与 Lody 认证扩展，而不只是检查 metadata。检查还会
  调用 `providers/list`，并确认 `session/new` 返回 `auth_required`，不会擅自猜测 Provider。在具备
  sandbox 条件的 Host 上，检查随后通过打包后的 control entry 配置本地虚拟 OpenAI Responses
  Provider，并驱动最终 ACP bundle 完成动态 thinking 与 permission 配置、模型请求的并行 Read
  Tool、模型请求的 Bash Tool、worker `SIGKILL` 后的 durable load/replay 与 resume，以及
  fork-at-turn/list/delete。filesystem worker 与 sandbox helper 因而会被真实执行，而不只是检查
  文件存在。这是确定性的 Darwin 证据，不代表 Windows/Linux 打包 helper 已完成验证。
- Electron 打包环境只为 Sorbet 可信的内部 filesystem 进程保留 `ELECTRON_RUN_AS_NODE`，sandbox
  的 credential filter 仍会隐藏其他 Host 环境变量。Lody 还会显式传入构建产物中 filesystem
  worker 的绝对路径，因为 Vite 可能把引用 Sorbet 的模块移动到共享 chunk，其相对位置与 worker
  无关。
- Sorbet 的确定性代理回归测试会通过 `ALL_PROXY` 把全局 `fetch` 发送到本地 CONNECT 代理，再
  证明 `NO_PROXY` 会绕过同一个代理；测试不会连接真实 Provider。

## 建议的运行拓扑

```text
Lody Machine
  Lody CLI / supervisor
    Lody Session A  ---- stdio ACP ----  Sorbet worker A
    Lody Session B  ---- stdio ACP ----  Sorbet worker B
    Lody Session C  ---- stdio ACP ----  Sorbet worker C

  Lody data root
    Loro session and collaboration state
    agents/sorbet/
      sessions/<sorbet-session-id>/...   每个 session 只有一个 writer
      artifacts/...
      credentials/configuration          机器级变更串行执行
```

`Session.createAgent` 已经给出了正确的进程生命周期：一个 Session 启动一个 ACP 进程，并选择
new、load、resume 或 fork。Sorbet 的持久会话仓库让新的目标进程能够找到 fork 来源，因此增加
独立 daemon 并不会提供必需的新能力。

Sorbet 数据目录必须从 Lody 的 `getLodyDataDir()` 契约派生，例如
`<lody-data>/agents/sorbet`，并显式传入。它必须遵守 `LODY_DATA_DIR` 和安装 profile，不能使用
Sorbet 默认的 `~/.sorbet`。这个目录在机器内共享，新的 worker 才能恢复或分叉既有 Sorbet
Session；如果每个 worker 使用独立目录，这项能力会失效。

## 状态与权威来源

| 事项                          | 权威来源                                           | 接入要求                                                                                                     |
| ----------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 产品对话、协作和 UI 状态      | Lody/Loro                                          | ACP replay 必须按稳定身份合并，不能重复已经落入 Loro 的消息。                                                |
| 执行证据和 Sorbet 恢复        | Sorbet Journal                                     | 保留 append-before-apply 证据；无法证明未送达的中断副作用恢复为 `unknown`。                                  |
| 活跃进程归属                  | Lody Session supervisor；Sorbet JSONL writer lease | Lody 避免重复启动；Sorbet 在 Journal 边界拒绝第二个 writer，Lody 将 busy 映射为明确的恢复或孤儿进程处理。    |
| Provider 凭据与 Provider 配置 | Lody Machine / 执行主机                            | 凭据保持机器作用域，变更串行执行，并在安全的 turn 边界刷新 worker。                                          |
| 请求者授权、归因和 Git 身份   | 本 turn 冻结的 Lody 用户身份                       | 不能从机器级 Provider 凭据推断用户身份。                                                                     |
| 标题                          | Lody                                               | 将 Sorbet 标题归属注册为 `none`；Sorbet 当前发布的是由首条 prompt 得到的标题，继续使用 Lody 的隔离标题生成。 |
| 运行时版本                    | Lody release                                       | capability cache 身份包含锁定的 Sorbet revision/协议版本，并随 Lody 升级或回滚而变化。                       |

Sorbet 的 `JsonlJournalStore` 现在在扫描、tail repair 和 append 前，按 canonical Journal 路径取得
Store-owned writer lease，并持有到文件 handle 关闭。第二个进程会得到
`JournalWriterBusyError`；owner 被 `SIGKILL` 时操作系统立即释放锁，替代 worker 不等待 stale
timeout 即可恢复。Lody 不需要再实现一套 Journal 正确性锁，只需避免无意义的重复启动，并把 busy
区分为仍有活跃 worker、待处理孤儿进程或错误 attachment。

这项要求不是从 Pi 继承的。Sorbet 自己定义了 Journal、事实 schema、append-before-apply
barrier、完整性链和恢复投影，只在 model 与 Tool 接口上使用 Pi library。原生 Pi 同样直接向一个
JSONL session 文件追加，而且没有按 session 建立的文件锁。当前 Pi 接入通过 Lody 基于操作系统的
“每个 installation profile 一个 host”lease、进程内 `SessionManager` map、create 去重和串行 turn
dispatch，让正常路径保持单 writer；它把原生 Pi 文件路径作为 ACP session id，由替代连接重新打开。
这是一项拓扑不变量，并不是按原生文件建立的锁；如果两个不同的 Lody Session 记录指向同一个 Pi
文件，仍然不安全。Sorbet 已经在自己的 JSONL 边界补上缺失的强制互斥；Pi 是否也要加固可以独立
处理，不能再作为 Sorbet 接入的前置条件。

共享文件需要另一套规则。Sorbet 的 `JsonCredentialStore` 现在会在读取时重新加载磁盘，并在
reload、OAuth refresh 和原子替换的整个过程持有跨进程 SQLite lease，因此活跃 worker 不会再
丢失凭据更新。Lody 通过单一 Machine control queue 串行执行所有内置自定义 Provider 变更，
per-Session worker 在进程启动时读取定义；运行中和恢复的 Session 保持固定值，不接收 Session
中途的 Provider 改写。直接使用外部 writer 不属于这项接入契约。Lody 在开放 approval reviewer
控制前，仍需为它补上等价协调。

## Provider 产品行为

Provider 配置属于实际执行任务的 Machine，并在 Lody 中通过独立的 Sorbet 配置界面呈现。这个
界面不是 Agent config 表单，而是账户、连接与模型控制中心，负责：

- Codex OAuth 登录与状态，并把它作为推荐的默认连接；
- 在 Claude OAuth 登录或选择前要求用户明确启用；
- 可信 API key 录入：secret 直接发送到目标 Machine，绝不进入 ACP elicitation、Loro state、
  prompt、Journal、保留的进度或日志；
- 自定义 Provider 定义、endpoint、模型目录、非敏感连接状态，以及按 Provider 单独退出；
- 本 Machine 的 Sorbet 默认连接。

Agent config 可以记录可移植的连接偏好、模型、reasoning level 和其他执行参数；Session 记录本次
实际解析出的连接与模型。新 Session 的解析顺序是：明确的 Agent/Session 选择、Machine 默认值、
有效的 Codex OAuth。Claude OAuth 永远不会被隐式选中。没有可用选择时，Lody 打开配置入口，
而不是自行猜测。

修改 Machine 默认连接只影响新 Session。恢复时继续使用该 Session 已记录的连接；如果连接不可用，
Session 进入 blocked 状态并要求用户选择替代连接，Lody 不会在 turn 执行中自动 failover。用户
明确替换后，必须先把它持久化为一次 Session 配置变更，后续工作才能使用新连接。

OAuth 继续走 Sorbet ACP authentication method 与 Lody 现有 URL/elicitation client。通用 ACP form
elicitation 明确不能携带凭据，所以 API key 必须使用可信的 Machine RPC：它接收加密 secret，
通过 Sorbet credential 边界写入，只返回 metadata。标准 ACP `agent.logout` 当前会清空 Sorbet
全部凭据，因此按 Provider 单独退出也属于这条 Machine control plane，而不能复用全局 logout。

## 已有协议适配情况

Sorbet 已经支持 Lody 所需的以下 ACP 行为：

- new、load、resume、close、delete、list、fork、prompt、cancel、model、mode 和 config option；
- 持久对话与 Plan replay；
- 权限请求、结构化 elicitation、文件系统工具、终端工具、直接 MCP 组合、图片和嵌入资源；
- 标准用量和 Lody 详细用量；
- Lody turn id 和 fork-at-turn；
- 活跃 turn 转向及精确 acknowledgement；
- Lody goal、压缩活动和子 Agent 生命周期、列表、取消及输出；
- 对中断的模型请求、审批和外部副作用进行持久恢复。

兼容矩阵中未支持的条目并不全是 Lody 产品能力缺口：

- Lody 的定时任务和跨 Session 任务由 host 管理。Sorbet 缺少原生 `tasks` 扩展不会关闭这些
  任务，而且 Sorbet 已独立提供子 Agent。
- Lody 直接传递 MCP 配置，当前接入不需要标准 MCP-over-ACP transport。
- Sorbet 通过 Lody 扩展投影压缩过程，因此缺少标准 ACP v2 compaction update 不是当前
  Lody 客户端的阻塞项。
- Sorbet 当前没有原生命令目录。现有 Lody skill 仍由 host 管理；如果 Sorbet 以后增加原生
  slash command，必须同时发布 `available_commands_update`，才能把这些命令标为受支持。
- Provider rate-limit window 仍然缺失。如果某个内置 Sorbet Provider 能提供额度数据，则该
  Provider 上线前必须实现 Lody `rateLimits` 扩展；Provider 本来没有数据时，Lody 也不能伪造。

Sorbet 会动态发布 model、thinking level 和 permission mode。Lody 已能接收 config update，
但接入测试必须覆盖切换到 thinking level 列表与初始模型不同的模型；只看初次 capability probe
不足以证明这条链路正确。

## 打包与启动

建议由 Lody 精确锁定 Sorbet 源码 revision，使用与现有 ACP adapter 类似、可审查的源码 pin。
Sorbet 当前所有 package 都是 `0.0.0` 的私有 workspace package，把它当作独立 npm runtime
会额外创造一套目前并不存在的发布契约。

Lody 应增加一个内置的 `sorbet-acp` CLI 入口，并像其他相邻 adapter 入口一样通过
`process.execPath` 启动。构建必须包含 Sorbet workspace 的依赖顺序和 `filesystem-worker`
产物；从全新 checkout 直接运行 ACP package 测试会因为 package export 指向尚未生成的
`dist` 而失败。

`@anthropic-ai/sandbox-runtime` 是运行时依赖，不只是 TypeScript 源码。它包含 Linux
x64/arm64 seccomp helper 和 Windows x64/arm64 executable；Linux 还依赖系统
`bubblewrap`，并受 kernel/user namespace 配置限制。Lody 的 Electron 打包目前只复制显式
列出的运行时 package chain，因此必须把 Sorbet 及其 helper 加入这份 staging 契约，并逐个
验证发布的系统和架构。沙箱不可用时应在 Session 可选前失败并给出可操作错误；静默降级到更弱
沙箱违反“不掉功能”的原则。

Electron lock 当前解析为 39.5.1，其内置 Node 22.22.0，满足 Sorbet 的 Node `>=22.19.0`
要求。独立 Lody CLI 仍声明支持 Node `>=22.14.0 <23 || >=23.6.0`。当前原型保留其他 Agent
的既有契约，只在 Node 低于 22.19 时拒绝 Sorbet 启动。builtin 上线前，打包与 UI readiness
必须把这个 Sorbet 专属错误清楚地呈现给用户。

公开 Electron 包的产品名还必须与 local installation profile 保持一致（`Lody OSS`）。主进程
导入的模块可能在后续 `app.setName()` 执行前就解析并缓存 Electron 的 `userData`；如果包元数据
仍写成正式版名称 `Lody`，OSS 构建就会与正式版共用用户数据目录和单实例锁，两者同时安装时 OSS
会直接退出。现在用回归测试约束这项包身份，保证并行测试时各自拥有独立状态和进程所有权。

Sorbet OAuth 可以使用 Lody 专用的 ACP authentication client 和 URL 流程。Sorbet 有意拒绝
通过通用 ACP form elicitation 传递 API key，因此 API key 配置需要可信的 Lody 凭据 UI/port
或受控环境导入，写入机器级 credential store，同时保证 secret 不进入 session journal、prompt
或 Loro state。

## 实施顺序

1. 在 Lody 中锁定 Sorbet 源码，构建相邻的 `sorbet-acp` 与 filesystem worker 入口，打包
   sandbox-runtime helper，并证明实际安装包入口使用 Lody 管理的数据根目录启动。
2. 把 Sorbet 注册为 builtin，同时保留协议驱动的认证方式；通过现有的“每 Session 一个 worker”
   生命周期验证 ACP initialize 以及 new/load/resume/close。
3. 在开发环境外开放前，验证 turn history、权限、模型/config 切换、steering、goal、compaction、
   子 Agent、usage、fork-at-turn 和 crash recovery。
4. Machine 级 Sorbet Provider Center、可信 API key RPC、按 Provider logout、自定义 Provider
   control queue、新 worker 选择 replay 和上述连接选择规则已经实现，可以进行手动测试。
5. 完成跨平台打包、沙箱、故障注入、升级和回滚门槛后，才能把 Sorbet 标记为 production-ready。

## 生产发布门槛

以下门槛全部通过前，不应向生产用户开放该 builtin：

1. package smoke test 在每个发布系统与架构启动实际打包的 `sorbet-acp` 入口，包括
   filesystem worker 和沙箱 helper。
2. 打包后的 Sorbet writer lease 在每个发布系统证明活 owner 排斥第二个 worker，`SIGKILL` 后可
   立即恢复；Lody 正确呈现 `JournalWriterBusyError`，且不会自动偷取活 owner。
3. 凭据、自定义 Provider 和 reviewer setting 变更能在 worker 间串行执行，并在明确的安全边界
   对已运行 worker 可见。
4. new、load、resume、close、delete 和 fork-at-turn 往返保持稳定 message/turn 身份，不产生
   重复 Loro 历史。
5. 故障注入覆盖 effect request 前后、effect 执行、effect terminal commit、Lody history flush
   和 turn pointer 更新前后的崩溃。只有已经证明未送达的操作可以重试；不确定副作用保持 `unknown`。
6. steering acknowledgement、goal、compaction、子 Agent 生命周期与输出、权限、Plan review、
   文件/终端工具、MCP、模型切换、thinking level、图片、用量和 turn diff 均通过 Lody 真实 UI 与
   持久化链路的端到端测试。
7. OAuth 登录/退出和可信 API key 配置不会泄露凭据；Sorbet 能取得配额的 Provider 正确显示额度。
8. 桌面端与独立 CLI 运行时下限、打包后的沙箱前置条件、升级、降级，以及回滚到上一份 Lody
   内置 Sorbet revision 均经过验证。

## 考虑过的替代方案

机器级常驻 Sorbet host 可以集中管理凭据和 catalog，但会增加新的 daemon 生命周期和共享故障域；
Lody 已经具备每 Session 的进程监管，因此只要明确处理共享文件协调，就不需要该 host。

单独下载 Sorbet release 可以复用 Lody managed runtime 机制，但会给用户增加第二套版本和回滚
入口，也要求 Sorbet 发布一套跨平台 runtime 契约。当前选定的产品方向是随 Lody 打包锁定的 runtime。

给每个 worker 单独的 Sorbet 数据目录可以避免共享文件竞态，但替代进程的 load、resume 和 fork
将需要不安全的状态复制或新的复制协议。机器级共享根目录加每 Session 独占 owner 更符合 Sorbet
当前持久化模型，边界也更小。

## 证据与限制

- 记录基线上的 Sorbet ACP compatibility test 通过。
- 执行 `pnpm --filter @sorbetai/acp... build` 后，Sorbet ACP 测试全部通过：5 个文件、36 个测试。
- Sorbet 已实现 Store-owned Journal writer lease；同进程互斥、真实双进程互斥、owner close 和
  `SIGKILL` 后立即恢复均有测试，Runtime 全套 14 个文件、187 个测试通过。
- Sorbet credential store 现在会重读已提交状态，并跨进程序列化变更；进程内 attachment
  registry、自定义 Provider store 与 reviewer setting 仍需完成上文列出的 ownership 工作。
- 当前原型 pin 上的 Sorbet NodeAgent 全套 11 个文件、94 个测试通过，其中包括打包后的
  Windows SRT helper profile 回归测试与 Electron Node-mode worker 回归测试。
- 在 Darwin arm64、Node 24.14.0 环境下，完整 Lody CLI release build 通过，生成的 Sorbet
  runtime 目录约 23 MB。最终打包入口通过 ACP initialize、OAuth 声明、执行到 Codex 第一个登录
  方式提示、`providers/list`、空 credential store 的 `auth_required`、自定义 Provider control、
  模型驱动的并行 Read 与 Bash 执行、动态 Session 配置、worker crash 后的 load/replay 与 resume，
  以及 fork-at-turn/list/delete 检查。Provider Center 组件测试覆盖 Machine capability 门控、Claude
  直接启用、自定义模型去重，以及 API key 只进入专用 secret RPC。仓库级 `pnpm check` 也已通过，
  包括 shared、components、CLI、Electron、i18n 和源码边界的完整检查。
- Electron 官方发布信息显示 39.5.1 使用 Node 22.22.0。Darwin arm64 installer 已连同内置
  runtime smoke check 构建完成，并使用 ad-hoc 签名进行本机测试；安装后的 `Lody OSS` 已在正式版
  Lody 仍运行时成功启动，使用独立的用户数据目录和单实例锁。
- 在 Darwin arm64 上，Electron 39 Helper 以 Node mode 运行 Sorbet 原生 SRT 边界测试，并调用
  构建产物中的同一份 filesystem worker；受保护路径仍被拒绝，Workspace 读写正常完成。CLI bundle
  lifecycle smoke 还覆盖了模型驱动的 Read、Bash Tool 与 replacement-worker 恢复。本次没有执行
  真实 Provider 登录、付费模型请求、从已安装 UI 由模型驱动的 Tool 执行、Lody 集成层外部副作用
  或打包后的 Windows/Linux 启动；Sorbet Runtime 层的 `SIGKILL` 与双 worker 竞态已经验证，打包后
  的相同行为仍是发布门槛。

## 实现入口

- [Builtin Agent 与标题策略](../../../../packages/shared/src/ai.ts)
- [Builtin 启动解析](../../../../apps/cli/src/agent/setting.ts)
- [Lody Session 进程生命周期](../../../../apps/cli/src/session/session.ts)
- [Lody 安装数据根目录](../../../../packages/shared/src/node/installation-profile.ts)
- [Electron CLI runtime staging](../../../../apps/electron/scripts/cli-native-deps.mjs)
- [Sorbet ACP 入口](https://github.com/LodyAI/Sorbet/blob/875da2768db0b3b5aa82bf69e1b80ad89f925571/packages/acp/src/stdio-cli.ts)
- [Sorbet Lody 扩展声明](https://github.com/LodyAI/Sorbet/blob/875da2768db0b3b5aa82bf69e1b80ad89f925571/packages/acp/src/agent.ts)
- [Sorbet 兼容矩阵](https://github.com/LodyAI/Sorbet/blob/875da2768db0b3b5aa82bf69e1b80ad89f925571/packages/acp/COMPATIBILITY.md)
- [Sorbet NodeAgent 组合](https://github.com/LodyAI/Sorbet/blob/875da2768db0b3b5aa82bf69e1b80ad89f925571/packages/node-agent/src/agent.ts)
- [Sorbet Session registry](https://github.com/LodyAI/Sorbet/blob/875da2768db0b3b5aa82bf69e1b80ad89f925571/packages/node-agent/src/sessions/registry.ts)
- [Sorbet JSONL Journal](https://github.com/LodyAI/Sorbet/blob/875da2768db0b3b5aa82bf69e1b80ad89f925571/packages/runtime/src/journal/jsonl-store.ts)
- [当前 Pi adapter 生命周期](../../../../packages/acp-extension-pi/README.md)
- [当前 Pi 原生文件恢复](../../../../packages/acp-extension-pi/src/connection.ts)

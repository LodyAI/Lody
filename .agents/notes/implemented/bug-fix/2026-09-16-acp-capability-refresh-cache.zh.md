# 不再在每次重连时重复探测 ACP 能力

Status: implemented
Translation: current

[English](2026-09-16-acp-capability-refresh-cache.md)

## 摘要

在空闲机器上，`machine/acp-capabilities-refresh` 每天真实启停约 1700 次 ACP Agent 进程——
六个 config 每五分钟一轮，每次 0.8–7.1 秒——而每一次探测算出的能力条目，都与已经存好的那份
在 `capabilitySourceVersion` 未变的情况下完全一致。两个彼此独立的缺陷共同造成了它：机器侧
根本没有缓存命中路径；渲染端"只跑一遍"的闸门是一个布尔值，任何 abort 都会把它清掉，于是每
一次 presence 重连都会重新探测全部 agent config。现在机器在条目确实来自真实探测、其 source
version 恰等于当前启动输入会产生的版本、且未超过 24 小时时，直接用该条目回答；启动期发现改为
按 config 记录完成情况，因此被打断的一遍重启后不会重复探测任何已回答的 config。显式探测——
设置页刷新、认证后校验、引导流程的 Provider 测试、provider setup——都设置新增的 `force` 标志，
并通过 `MachineMeta.protocolCapabilities` 协商，因为早于该字段的 daemon 会严格解析请求并把它
丢弃。剩余的不确定性在下文点明：渲染端那个布尔值为何始终没有 latch，无法仅凭机器侧日志确定，
因此修法选择在两种候选机制下都成立，而不依赖于知道答案。

## 日志实测

数据来自 `~/.lody/logs/2026-09-16.log.1`（02:11–10:29，一台机器、三个 workspace）与已轮转的
`2026-09-16.log.gz`：

- 755 次刷新请求、764 次 `[acp-startup] creating ACP client`、793 次 `Starting ACP client`。
  按小时分桶，ACP client 创建稳定在 72 次/小时——正好是六个 config 每五分钟一轮，也就是说稳态
  下除了能力刷新几乎没有别的。
- 126 个请求批次中有 104 个恰好包含六个请求，每批跨度 14–23 秒，批间间隔锁定在 300–302 秒。
- 每一批请求的都是同样的六个 config，顺序也相同：claude、pi-acp、opencode、grok、kimi、
  deepseek。

解码机器自己的 Flock 文档（`~/.lody/loro-repo/<workspaceId>/repo.sqlite3` 的 `flock_docs`
表中 `:mf:<machineId>` 那一行，用 `@loro-dev/flock-wasm` 读）在不给 App 加探针的前提下定位了
触发方：

- 该机器恰好有六条存活的 `agentConfig` 行，把它们的 id 排序得到的正是观测到的请求顺序。那就是
  `runStartupAcpCapabilitiesRefresh` 遍历的 `Object.values(getMachineFlockAgentConfigs(...))`
  ——完整的 config 列表。
- `acpCapability` 行在每一轮之间的 `sourceVersion` 完全相同（例如
  `builtin-claude-acp:0.70.0+agent-sdk:0.3.258+claude-code:2.1.258`），只有 `fetchedAt` 推进到
  最近一轮。每次探测都在重算它已经拥有的答案。

## 是哪个触发方，不是哪个

任务点了两个候选。Agent Role 重整 hook（`use-agent-role-schema-reconciliation.ts`）被它自己的
探测集合排除：该 workspace 下七个自有 Role 引用四个不同 config——claude、codex、deepseek、
grok——既产生不了观测到的 `pi-acp`/`opencode`/`kimi` 请求，也不会漏掉 `codex`。它解释的是那些
偶发、不在节拍上、且确实含 `codex` 的突发批次；这些现在由机器侧缓存直接回答，不起进程。

周期性的那一轮是 `runStartupAcpCapabilitiesRefresh`，由 presence 传输每 300 秒离开又回到
`synced` 驱动（机器自己的房间日志记录了同一个租约：`Loro presence room status: reconnecting`
→ `joined`，227 次）。两个结构性事实把"一遍启动扫描"变成了常驻循环：

- `scheduleAfterStartupNavigationCooldown` 算的是 `max(0, lastNavigationAt + cooldown - now)`。
  在没人操作的 App 里 `lastNavigationAt` 早已过去，于是 30 秒冷却退化为 0 毫秒，一次重连立刻
  开始一遍——与批次起点落在租约边界一秒内的观测吻合。
- `startupAcpCapabilitiesRefreshCompleted` 只在一遍未被 abort 地走到结尾时才置位，而 presence
  订阅的非 `synced` 分支会 abort 正在进行的那一遍，`.finally` 又把它重排。没有任何地方记录哪些
  config 已经回答过，因此每次重启都是一次完整重探。

**明确的界限：** 机器侧日志无法说明那个布尔值为何在八小时里始终没有 latch。剩下的两种解释都
要求 presence 在一遍（约 20 秒）进行中再次离开 `synced`——要么渲染端的租约边界发出了多于一次
状态跃迁，要么它在刷新后调用的 `resyncMachineFlockRows(requireRemoteSync: true)` 活过了那个
窗口（机器在每一批期间都记录了 `reason=acp-capability-update` 的
`Streams sync failed: internal_error` 与重试）。区分二者需要渲染端探针，而本地 composition
没有托管 presence 房间可供复现。因此修法不依赖答案：把完成情况记在 runtime 作用域的集合里之后，
被重新装填的那一遍就是空操作，无论它被装填多少次、也无论布尔值为何是 false。

## 机器侧缓存

`refreshMachineAcpCapabilitiesForConfig` 在既有的 in-flight 去重之前先查已持久化条目。命中要求
同时满足：期望 source version 可解析、在当前 `cacheVersion` 下 `sourceVersion` 完全相等、
`provenance: 'runtime'`、且年龄在 `ACP_CAPABILITY_REFRESH_CACHE_TTL_MS` 之内。该判定由
`@lody/shared` 的 `decideAcpCapabilityRefreshCache` 拥有，并给出每种 miss 的原因，机器会记录它。

不显然的一点是如何算出"一次探测会打上的版本"。存下的版本是*启动器*产生的，对 managed builtin
还包含已安装的 runtime 版本（`builtin-kimi:0.36.0`），单靠
`getAcpCapabilitySourceVersion(input)` 复现不出来。因此
`resolveExpectedAcpCapabilitySourceVersion` 去读 `getRuntimeStatus()`——本地、不下载、不起
进程——并在 runtime 未安装时返回 `undefined`，因为拿内置的目标版本顶替，会让缓存条目活过一次
从未发生的安装。它同时镜像 `resolveManagedRuntimeForLaunch`：在 `updateAvailable` 时向更新
协调器入队。此前这个入队只能经由启动路径到达，而实践中恰恰是空闲期的能力刷新在发现 managed
runtime 更新。

### TTL 为何取 24 小时

source version 已覆盖 Lody 能控制的全部输入，所以 TTL 只用来限定 Lody 观察不到的漂移：用户在
Agent 自己的配置里改动的斜杠命令、子 Agent 或模型权限。有两条路径比任何 TTL 都收敛得更快——
`scheduleCreatedSessionCapabilityUpdate` 会用每个真实会话的 `session/new` 响应重写条目，所以
真正在用的 Agent 是免费刷新的；设置页还提供显式强制刷新。留给 TTL 覆盖的只剩没人启动的 Agent，
在那里取更短的值收益很小：一小时在这台机器上约 144 次探测/天，一天约 6 次，两者都远低于实测的
约 1700 次。`fetchedAt` 落在未来算作新鲜而不是重探的理由，因为写方与读方用的是同一个服务器时钟，
负年龄意味着时钟调整。

## `force` 必须协商，而"省略"就是机制本身

本改动的第一版无条件发送 `force: true`，被评审抓到了。两条传输在机器侧都用严格 schema 解析，
因此早于该字段的 daemon 不会忽略它：

- **Machine RPC：** `handleRawRequest` 里 `LoroStreamsRpcRequestSchema.safeParse` 失败，只打一条
  warning 然后 **直接返回，不追加任何响应**。调用方看不到错误，只能等到客户端兜底超时——比被
  拒绝还糟。
- **本地 local control：** `LocalSessionControlRequestSchema` 是基于同一个严格的
  `MachineAcpCapabilitiesRefreshRequestSchema` 的判别联合，daemon 直接回 HTTP 400
  `invalid_request`。这条路径和远程一样重要，因为桌面应用与 CLI daemon 各自独立升级，任何一侧
  都可能是较新的那一侧。

对照 `4de83a57` 的改动前文件已确认：两个 schema 都是 `.strict()`，且都未声明 `force`。并在
zod 4.3.6 上实测确认：`.strict()` **即使该键的值是 `undefined` 也会拒绝**——这正是
`negotiatedAcpCapabilitiesRefreshForce` 返回可展开的 `{}` 而不是 `{ force: undefined }` 的原因。
"falsy force" 那种写法会以一种看起来已修好的形式把同一个 bug 发出去。

能力键是 `acpCapabilityRefreshCache`，版本 1，按 `packages/shared/AGENTS.md` 的要求与它的版本
常量和检查函数一起声明在 `machine-protocol-capabilities.ts`。有意用一个键覆盖两件事：不做缓存
的 daemon 恰好就是拒绝 `force` 的 daemon，拆成两个键只能造出一个不可能存在的状态。对所有调用方
而言退化都是空操作——这样的 daemon 本来总是探测，正是强制刷新想要的；而非强制的调用方拿到的就是
改动前的行为。

协商只发生在两处，区别在于哪些请求会跨越版本边界：

- `create-workspace-runtime.ts` 的 `requestMachineAcpCapabilitiesRefresh`，两条 plane 都经过的
  单一收窄点，因此渲染端各调用方继续照常传 `force: true`。
- `apps/cli/src/commands/agent-config.ts`，因为 CLI 二进制可能比它所派发的 daemon 更新。

CLI 的进程内调用方——`session-execution-service.ts` 里认证后的校验与
`provider-setup-manager.ts`——有意**不**协商：消息从未离开创建它的那个构建，在那里做能力检查
只可能与自己意见不一致。

## 全部调用方，以及各自是否 force

| 调用方 | 是否 force | 原因 |
| --- | --- | --- |
| `create-workspace-runtime.ts` 启动扫描 | 否 | 它要的就是缓存；被消除的正是这项开销 |
| `use-agent-role-schema-reconciliation.ts` | 否 | 它对照的是当前条目，不关心是谁产生的 |
| `machine-agent-settings.tsx` 设置页刷新 | 是 | 有人改了启动输入之外的东西 |
| `providers-screen.tsx` 引导 Provider 测试 | 是 | 它存在就是为了证明 Agent 能启动 |
| `commands/agent-config.ts` `refresh-capabilities` | 是 | 与设置页同一意图；第一版漏掉了 |
| `session-execution-service.ts` 认证后 | 是 | 新凭据会改变权限授予 |
| `provider-setup-manager.ts` 校验 | 是 | 证明刚安装的 runtime 能启动 |

这是请求构造点的完整集合；该清查可用 `grep -rn "'machine/acp-capabilities-refresh'"` 过滤出
请求字面量来复现。

## builtin Agent 不能改用静态表

`STATIC_BUILTIN_ACP_CAPABILITIES` 针对第 4 项做过评估，并有意未采用。它自己的契约就这么写着——
"deliberately not a probe mode: machine capability refreshes should start the real ACP runtime"
——数据也支持这一点：它不带 `availableCommands`、`sessionFork`、`acknowledgedSteer` 与
`goalActions`，只要存在 runtime override 就返回 `undefined`，而它的模型列表是 Lody 自己写死的
常量，而非已安装 runtime 与用户账号实际提供的东西（`kimi` 与 `deepseek` 的模型列表本就是空）。
用它回答一次刷新会发布 `provenance` 不为 `'runtime'` 的条目，并悄悄降级会话能力。缓存一次真实
探测的结果能拿到同样的进程节省而不编造数据，所以本记录走的是后者。

## 考虑过的替代方案

- **给重连触发的每一遍加最小间隔。** 否决：那是一个掩盖真实缺陷的启发式下限，而根 `AGENTS.md`
  要求显式契约优先于隐藏兜底。按 config 记录完成情况直接陈述了意图中的契约。
- **只按 `cacheVersion` 与年龄做缓存键。** 否决：那样 runtime override 或改掉的
  `DEEPSEEK_HARNESS_BASE_URL` 会被一份描述了另一个二进制的条目回答。
- **让机器在时间窗内忽略重复请求，而不是回答它们。** 否决：调用方确实需要当前条目（Role 重整
  就需要），而拒绝回答会把一次廉价读变成错误路径。

## 验证与界限

行为覆盖见 [Spec](../../../../specs/acp-capability-refresh-cache.md) 中列出的测试；机器侧测试
断言的是"没有启动探测"，而不是某个 mock 被调用了几次。协商测试把客户端实际发出的 payload 对照
一份**由当前 schema 派生**的上一代 schema（`.omit({ force: true })`）校验，因此该重建不会与实际
发布过的形态漂移，两条传输都覆盖。

未验证：在运行中的桌面构建上的端到端效果，因为复现 300 秒 presence 租约需要托管 presence 房间。
同样未被测试覆盖的是：`refresh-capabilities` 命令自身的调用点确实传了 `force`——驱动那个
Commander action 需要替换掉 `getAuthContextOrThrow`、`withWorkspaceManager`、
`listMachineMetasForWorkspace` 与 `dispatchLocalControl`，得到的断言会是关于这些 mock 而不是关于
行为。它所展开的那部分在协商测试里已按真实形态覆盖。对实测那台机器的稳态预期是每天六次
探测而非约 1700 次，但这是从缓存判定推出的预测，不是测量结果。

相关：[ACP capability cache compatibility](../../../../specs/acp-capability-cache-compatibility.md)
规定*读方*如何容忍来自其他版本的条目；本记录与其 Spec 规定机器何时可以用一份条目回答刷新。

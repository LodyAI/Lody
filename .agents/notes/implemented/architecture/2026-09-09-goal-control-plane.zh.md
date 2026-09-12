# 为 goal 操作建立独立控制平面，取代 `/goal` prompt 桥接

Status: implemented
Translation: current

[English](2026-09-09-goal-control-plane.md)

## 摘要

暂停或恢复 Codex goal 此前是以聊天消息（`/goal pause`、`/goal resume`）投递的，因此需要占用会话的 ACP
prompt 槽位——正是运行中的 goal 跨 agent 自身续接所长期持有的那个槽位。分发监视器会以
`guard-noop-active-session` 静默推迟这些 turn，而 goal 横幅在等待期间禁用了所有按钮，于是可见症状就是：
一个已暂停的 goal，其「恢复」按钮毫无反应，直到用户按下「停止」。goal 操作现在按其行为拆分：`pause` 与
`clear` 走带外的 `_lody/session/goal` 扩展请求并在 prompt 进行中生效，而 `set` 与 `resume` 搭载由 Lody
拥有的 prompt，以 `_meta.lody.goalControl` 元数据传递，并在排空中的 turn 之后排队而不是被丢弃。该拆分是
横跨 `acp-extension-core` 与 Codex adapter 的协议变更；它由 adapter、CLI 与组件测试验证，而非针对真实的
Codex goal 验证。

## 问题

`GoalPromptLifecycle`（Codex adapter，2026 年 9 月）让一次 ACP v1 prompt 覆盖活跃 goal 的每一次原生续接。
这是正确的生命周期——正是它让 goal 的各轮都归属到同一个会话条目——但这也意味着活跃的 goal 会永久占用会话
唯一的 prompt 槽位。

Lody 的 goal 控件是 prompt 文本。每次按下都会写入一个待处理的用户 turn 并请求 CLI 分发它。只要有 turn 处于
活跃状态，`resolveSessionDispatchAction` 就返回 `noop('active-session')`，因此该 turn 会一直挂起直到 goal
的 prompt 关闭。与此同时，横幅的 `pendingGoalCommand` 只在 goal 状态真正变化时才清除，没有超时，并且它会
禁用所有 goal 按钮。取消该 turn 是用户唯一能触达的出路——这正是用户们找到的绕行办法。

暂停此前已经因同一根因积累了补偿措施：「停止」按钮会自行发送 `/goal pause`，而 adapter 也会在被取消的
prompt 路径中自行暂停 goal。两者存在的原因都是：该桥接无法在一次 prompt 期间投递命令。

## 决策

按操作是否启动新工作来拆分 goal 操作。

仅改状态的操作（`pause`、`clear`）走带外通道。`acp-extension-core` 本就定义了 `_lody/session/goal`；该能力
现在会指明哪些操作在那里是安全的（`controlActions`），而 Lody 终于会去调用它。不需要 turn、不需要 prompt
槽位、不需要队列。

启动工作的操作（`set`、`resume`）需要一个安放所产生 turn 的位置，而 ACP v1 只给客户端一个这样的位置：它
自己的 prompt。Core 新增了 `LodyGoalPromptControl`，通过 `prompt._meta.lody.goalControl` 携带，adapter 把它
路由到与 slash 命令相同的代码。会话中绝不再出现由按钮生成的命令文本；用户输入的 `/goal xxx` 与既有子命令
仍然受支持。adapter 仍会接管 Codex 原生启动的 turn，而不是提交一个重复的。

顺序由 CLI 拥有。`SessionExecutionService.controlSessionGoal` 在传输层允许时发送请求；否则它 ack 为
`queued`，由单一的会话 worker 开启一个 goal turn（`dispatchSource: 'goal'`，无用户消息、无运行配置），并
通过 `waitForTurnRelease` 等待所有权。PR #554 评审之后的更正：原先的三轮上限会静默丢弃已接受的请求。已接受
的工作现在会一直等待，直到可以运行、被取代，或可见地失败。元数据加载的争用会针对新的所有者重试；claim 与
提交前的围栏可防止被取代的请求抵达 provider。更新的带外 Pause/Clear 与针对确切 turn 的 Stop 会作废待处理的
goal 工作。接受不等待 prompt 完成，也不宣称 `turn_started`。

UI 现在从 ACP 能力缓存读取 `goalActions`，而不是判断 `agentType === 'codex'`，其 pending 状态一分钟后过期，
因此一次缓慢的操作不会让横幅永久失效。

## 更正之后的宿主简化

后续改动在不改变 goal 契约的前提下移除重复工作。生产代码消融之后，原有的 117 个宿主测试仍然通过；移除两个
被包含的测试后剩余 115 个通过。保留下来的围栏并非臆测：移除提交前围栏会导致 Pause 之后投递一个旧的 Resume。
其测试现在以显式的提交/释放信号进行竞速，并报告 `submitted`，而不是等待超时。没有新增队列抽象或认证机制。

| 消融                                              | 证据与决策                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 元数据读取的过期请求守卫                          | 移除；既有的 claim 围栏仍会拒绝它，包括两个 Pause/Clear 测试。                               |
| 队列先 `has` 再 `get`                             | 改为每次迭代只查一次；所有权测试全部通过。                                                   |
| 本地 `turn_started` 接受分支                      | 移除：该 handler 只返回 applied/queued/unsupported/error；wire 响应联合类型不变。            |
| goal 方法别名与仅用一次的兜底文案导出             | 移除；改用 Core 的方法常量，并把未改动的兜底文案内联到其唯一消费者。                         |
| 单轮队列测试与状态传输选择器测试                  | 移除；多轮队列与真实的 AgentClient wire 测试已覆盖其断言。                                   |
| 提交前围栏                                        | 保留：移除会让可观察的提交/释放测试失败；恢复后通过。                                        |

这是对宿主更正的有界简化，并不证明整个协议已被穷尽最小化。claim 跟踪、待处理操作的取代以及启动失败上报都
保留各自既有职责。

## 替代方案

**让 adapter 自己启动被恢复 goal 的 turn。** adapter 已经为无法发送 prompt 元数据的客户端提供了
`startGoalContinuationIfCurrent`。对 Lody 否决：CLI 会收到一个自己从未 prompt 过的 turn 的会话更新，而
`SessionTransientStore` 的迟到更新路由会把它们追加到此前已终结的 assistant 条目上——没有 turn 边界、没有
运行状态、没有 Stop 按钮。

**保留 prompt 桥接，只修排队。** 这能在不改协议的情况下消除失效的 Resume 按钮，但暂停仍然无法在它所要停止
的那次 prompt 期间被投递，而 Stop 的 `/goal pause` 补偿也只能继续保留。

**只允许 `set`/`resume` 作为 prompt 元数据。** 概念上更干净，但这样就无法清除一个会话并未运行的 goal：请求
路径需要一个活着的 agent。因此仅改状态的操作在两种传输上都被接受，而实时控制优先使用请求。在一次被恢复的、
已被占有的 prompt 内部，传输选择必须使用已广播的 prompt 路径，而不是先选择请求再以「与 prompt 不兼容」为由
拒绝它。

## 后果与限制

`ACP_CAPABILITY_CACHE_VERSION` 提升到 8，以便各机器重新探测并发布 `goalActions`。在某个会话所在机器刷新
之前，goal 按钮会被隐藏而不是错误地显示——这是保守方向。

`acp-extension-core` 现在是 0.1.4，Codex adapter 依赖该版本。在本工作区内，pnpm override 会把它解析到本地
源码；发布版的 adapter 构建需要先有新的 core 发布。

一个已暂停的 goal 仍可能正在排空它最后一次原生 turn，而这一点现在是可见的而非被隐藏：排队的 resume 会等待
然后运行。它不再需要 Stop，但也不是瞬时的。

两个 submodule 的改动都已合入；这些宿主更正无需新的 release。
[goal 控制 Spec](../../../../specs/session-goal-control.md) 仍为 draft。

## 验证

Adapter：prompt 元数据能在不带命令文本、也不产生第二次 `turnStart` 的情况下恢复一个 goal；解析器接受每一个
已广播的操作，并拒绝空目标、未知操作与未来版本。既有的 goal 生命周期、传输与线程事件套件仍然通过（37 个
测试）。

CLI：传输选择对仅改状态的操作优先使用请求；即便 agent 把启动工作的操作列入控制操作，也仍让它们走 prompt；
对两份列表都不广播的运行时回退到 slash 桥接；并拒绝未广播的操作。执行服务测试覆盖无 turn 的带外暂停、被
拒绝的操作、不携带运行配置的 goal turn、排在排空中 turn 之后并通过清空当前 turn 确定性释放的 resume（无
定时器、无 sleep），以及「最新者胜」的取代。CLI 套件除 `tests/gh-shim-script.test.ts` 之外全部通过，后者在
本沙箱中因本次未触碰的文件而失败。

组件：goal 命令由已广播的操作推导，包括部分广播的情形。shared、RPC、CLI 与组件的类型检查通过。

未验证：真实 Codex 会话对真实 goal 的暂停与恢复，以及消费已发布 `acp-extension-core` 的托管运行时构建路径。

后续更正（2026-09-10）：[独立评审与消融](../simplification/2026-09-10-goal-control-ablation.zh.md)发现了启动
ack、跨传输取代与冷会话状态控制方面的缺口。上文的宿主更正处理了这些结论，以及
[PR #554](https://github.com/LodyAI/Lody/pull/554) 中报告的「三次等待即丢弃」问题。新的回归测试以延迟的
provider 执行真实的宿主 turn 生命周期，验证会话历史中的失败记录，并针对冷会话状态控制演练 AgentClient 的
wire 负载，同时保持 `/goal xxx` prompt 不变。该队列仍是进程本地的，不是 daemon 重启后的恢复机制；未引入
持久队列或新的协议字段。
更正验证：117 个宿主测试（执行服务、AgentClient、传输选择）与 36 个 Codex goal 测试通过，包括输入式 slash
命令。CLI 生产类型检查、仓库 lint、定向格式化与文档检查通过。独立的 CLI 测试 tsconfig 仍因既有的 fixture/
类型错误而失败，不计入通过的验证。
提交前验证重跑了 `pnpm check`：工作区类型检查与 lint 通过，但测试阶段触及五分钟上限（exit 124），因此完整
检查不构成通过证据。`pnpm format` 完成；无关的 Electron 格式化改动已排除。未重跑真实 Codex 的端到端行为。

合并集成（2026-09-10）：合并 main 时同时保留 `SessionGoalAction` 与 Core 的 `createPlanModeConfigOption`
导入。Core 的 goal 分支现在也包含 main 的 worktree 项目契约（`2812417`），而 Codex 停留在已合入的 PR #39
（`33d897b`）。只选其中任一个旧的 Core 指针都会丢掉一份必需契约。在合并后的契约下，Core 的构建/类型检查与
Codex 的类型检查通过；CLI 所有权/goal 测试（122）、Codex goal/fork/worktree 测试（52）、shared 能力/配置
测试（26）与 goal UI 辅助测试（5）通过。这解决的是依赖不匹配，而不是此前记录的宿主侧 P1 结论。Core 的 goal
分支在仅从 registry 消费之前仍需自己的合并/发布。完整的工作区类型检查与 lint 也通过；`pnpm check` 进入测试
阶段但在五分钟上限被终止，因此完整套件不构成通过信号。格式化、文档检查与公开边界检查通过；无关的格式化改动
已从合并中排除。

发布集成（2026-09-10）：Core PR #7 已合入，0.1.4（`4c8ffe9`）同时包含两份契约；更早的 0.1.3 包并不包含 goal
prompt 控制。Codex 现在在其 manifest 与 npm lock 中固定 0.1.4，包括 registry 完整性校验。在一个没有工作区
override 的独立 clone 中，`npm ci --include=dev --ignore-scripts` 会安装已发布的包，Codex 的两项类型检查与
52 个 goal/fork/worktree 测试均通过。工作区的 frozen-lockfile 安装、Core 构建与 Codex 类型检查也通过。既有的
根 pnpm lock 无需改动，因为 Core 仍是工作区链接。这弥合了上文的 registry 依赖缺口；宿主侧的结论由本记录中的
更正单独处理。

# 原生 workspace presence 所有权

Status: implemented
Translation: current

[English](2026-10-12-effect-workspace-presence.md)

> 后续变更：[由 daemon 执行 MCP 工作区命令](2026-10-16-daemon-hosted-mcp-workspace-commands.zh.md) 允许应用注册表替换释放失败的已停止 owner；同一 owner 内替换远端 generation 仍被禁止。

## 摘要

旧 workspace 编排会在远程 I/O 尚未结束时丢弃句柄，bootstrap 读者也可能在超时后继续登记。现在 heartbeat 和远程代次由原生子 Scope 持有，释放失败保留完整 Cause 和拥有者，直到实际清理完成。产品 doc/bridge 从 CLI 应用 registry 获取 workspace，durable 与 ephemeral 请求借用同一个原生 token provider。正式 SDK 负责传输所有权；session-active 租约和本地 relay 节奏仍属于独立的 P6/P7 工作。

## 行为合同与组合

授权 attach 启动远程代次，本地 origin 分区的双 store 和 30 秒机器 heartbeat 独立于云授权运行。CLI 根以一个应用 runtime 提供 shell cache 和 workspace registry；`presence-legacy.ts` 是当前 doc/bridge、Session 和读者的唯一 presence 执行入口，消费者直接组合服务后删除。`PresenceReplica` 的 CRDT 编码、解析、set/delete 和快照保持同步；relay 只传本进程写入的状态。

workspace 在自己的子 Scope 创建 token provider。durable Streams 与 machine monitor 通过 `createLoroStreamsTokenProviderLegacy({provider, executor})` 借用同一 provider 和应用执行器，presence 使用原生回调。借用模式不创建 runtime 或第二个 cache，也不销毁借用的执行器。原生获取保持惰性，本地启动不读取凭据、不发云请求。撤销先结束两个远程 sink，移除 durable transport，再关闭 provider，本地 presence 继续生产；旧 provider 实际清理完成后重连才创建新 provider。

远程 detach 先关闭准入，中断任务，启动 SDK 关停，以独立有界观察者等待真实退出，再关闭代次 Scope。超时保留原释放 Fiber、拥有者和完整 Cause，禁止替换。并发 stop/detach 共用 Deferred 回执。显式恢复等待原工作结束，只在失败释放已结束后调用 SDK retry。workspace stop 先清理远程 I/O，再关闭 token Scope 和销毁 store。只有属于该 workspace 的已识别 provider 释放失败可以通过原生 retry 恢复；实际清理成功后才将历史 Scope 失败视为已恢复，外来失败仍可观察。

读者取消只结束自身 bootstrap/barrier/token 等待，不释放其他租约仍需要的生产者。应用 dispose 将 workspace/shell 的未释放拥有者转移进完整 Cause；组合恢复分派保留未知失败。doc 初始化、attach 回滚、detach 和最终清理都会保留释放错误，不再仅记日志或丢弃。其余 Promise doc 编排不属于该原生单元，不声称已迁移。

Scope.close 不加入先前的 close，中断不可中断 finalizer 也不能建立清理期限，因此在固定 Effect 4.0.2 原语上需要共享回执和保留释放 Fiber。本决定替换[通道预算决定](2026-09-20-ephemeral-presence-channel-budget.zh.md)中的生命周期机制，保留发布速率/大小、三态读者和唯一 session 写入者。

## 正式依赖与证据边界

平台 adapter 使用正式 `streams-crdt@0.17.0/effect`，其依赖为 `streams-client@0.10.0`。产品代码没有源码 bundle、本地 tarball、依赖 override 或第二套 POST/SSE 队列。minimumReleaseAge 仅放行已 review 的精确版本，无关 lockfile 解析保持不变。loro-repo 0.22.0 仍声明旧 CRDT peer 范围；选择该组合的兼容依据是实际 durable checkpoint 与产品边界测试，而不是忽略警告本身。

review 曾复现清空本地 presence 后正常 stop 产生 pending=0 的 EphemeralReleaseFailure，包含 EphemeralClosed；排队 send 在撤销时还未获取 HTTP。[loro-streams#410](https://github.com/loro-dev/loro-streams/pull/410) 已改为中断这项取消任务，保留真实外来/混合失败；移除单个 send guard 的消融可复现。上游完整检查通过 637 项、跳过六项。随后按 client→CRDT 顺序通过 [#412](https://github.com/loro-dev/loro-streams/pull/412) 和 [#411](https://github.com/loro-dev/loro-streams/pull/411) 正式发布。早期暂存源码快照的通过不能证明原本失败的上游 head；这里消费修正后的正式包。

joined bootstrap、捕获的逻辑链 barrier、ACK 和 peer receipt 是不同证据。SDK 阶段日志只包含安全枚举/计数；单次成功和 heartbeat 用 trace，失败用 debug，有界 retry/stall 用 warn。上传停滞不会自动触发重连，idle 只是本地队列为空，不证明 peer 观察到状态。没有新增 telemetry sink。

## 验证与剩余工作

[产品 PR #1510](https://github.com/LodyAI/Lody/pull/1510) 替换旧 Promise coordinator。原生 suite 覆盖 origin 分区、heartbeat/revoke、bootstrap/barrier 取消、retry、公平等待、并发 close、类型化/defect 清理失败、零 pending 的释放失败和 token Scope 失败恢复。正式 SDK 的 Fetch/SSE 用例验证忽略 abort 的 POST 在真实结束前禁止替换、取消 room 等待时共享 P4 token demand 保留、重连发送机器状态到真实 EphemeralStore，以及正常 stop 成功。借用 token 测试取消 Legacy 等待而保留原生等待，验证共享缓存，并证明 close 后应用执行器仍可用。

产品 manager、本地数据面/零云请求和 durable checkpoint suite 覆盖登记后的消费者边界。fake timer fixture 只控制所需 timer 时钟，保持 Effect 调度器运行；原生用例用 TestClock 和显式就绪信号。既有机制消融可检测类型化 Cause 丢失、代次过早替换和并发 close 不加入回执。

P6 session-active 所有权、P7 relay 节奏、更上层文档/Session/Turn 所有权、macOS/Windows 打包和生产 daemon 端到端验收都没有由 P5 完成。最终工作区类型检查和类型感知 lint 通过；presence/logger/产品 manager/durable checkpoint 通过 52 项，token/shell 通过 72 项，真实本地零云请求/数据面通过六项。renderer presence 通过 33 项，其期限 fixture 响应 AbortSignal 并推进默认重试退避，与实际 token facade 一致；忽略取消的无限回调属于未释放工作，不是期限清理成功。fake timer 不替换 Effect 调度器。格式、frozen 安装、docs check（零错误）、i18n 和五项边界检查通过。递归验证的 CLI 为 4,052 通过、15 失败、跳过一项、四个未处理错误；五个 process/Git shim suite 在未修改的 P1 源码复现相同 15 个失败和四个错误，相关文件与当前 main 一致；其中四个 suite 重试用五秒诊断期限。失败后其余递归验证未完成；Electron 单独补跑全部 216 项通过，不声称完整 check 通过，focused 验收不能替代这些限制。

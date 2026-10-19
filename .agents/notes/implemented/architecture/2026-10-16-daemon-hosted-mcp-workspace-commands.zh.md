# 由 daemon 执行 MCP 工作区命令

Status: implemented
Type: architecture
Translation: current

[English](2026-10-16-daemon-hosted-mcp-workspace-commands.md)

## 摘要

在 Cloud 组合下，每次触及工作区的 Lody MCP 工具调用，都会在 MCP 进程里打开一整套第二副本：Loro repo、Streams 传输、token provider 和 presence 订阅，调用结束时再全部拆掉。释放 presence 需要在五秒预算内完成网络 I/O，普通的慢网络就会让清理失败；而失败会被保留成一道栅栏：长期运行的 MCP host 里，该工作区之后的每条命令都以 `INTERNAL_ERROR`（"Workspace cleanup failed" / "Workspace presence operation failed"）失败，直到重启。现在，MCP 工作区工具在所有组合下都由 daemon 用它已有的副本执行（OSS 早已如此），且任何地方的释放失败都不再阻塞工作区。终端里独立运行的 `lody` 命令仍会打开短生命周期副本；打包应用与线上 Cloud 验收尚未测试。

## 缺陷是怎么叠出来的

每一步单独看都合理，叠在一起就让一次清理错误变成永久故障。

| 变更                                                                                                            | 影响                                             |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 公开历史（2026-08）：`withWorkspaceManager` 每条命令新建一次性 `LoroDocumentManager`                            | 每条命令都创建并销毁一份副本，包括 presence      |
| #1133（2026-09-29）：`session/call-tool` 在 daemon 中执行 Session 工具                                          | 仅限 OSS；Cloud 组合保留一次性路径               |
| `e0ad6d4` / `2263513`（2026-10-12）：原生 presence 注册表每个工作区只允许一个 owner，上一次释放未确认时拒绝替换 | 一次释放失败会拒绝之后所有 owner                 |
| #1560（2026-10-14）：重叠命令共用一个 manager，presence 未释放的清理失败会保留失败回执                          | 后续命令拿到旧错误，进不到自己的逻辑，也没人重试 |

presence 只是本地存储时，一次性 manager 很便宜；一旦它持有网络订阅和释放期限，就成了负担。栅栏又把一次有界的网络失败，变成了某个工作区无限期的不可用。

## 决定

```text
agent / MCP 客户端
      │  MCP 协议、operation store（留在 MCP 进程）
      ▼
MCP 进程 ──session/call-tool──▶ daemon：唯一的工作区副本
                                ├─ Loro repo、Streams 传输、token provider
                                └─ presence owner（写心跳、读在线状态）
```

- 一台机器上，daemon 持有唯一的工作区副本。Session 与目录类 MCP 工具（包括 MCP 配置、归档、取消和 schedule）都在那里执行；`session/call-tool` 同时服务两种组合。
- `runWithDaemonWorkspace` 把 daemon 的 manager 借给 daemon 执行的命令。它只改变命令使用哪份副本：Cloud 的鉴权、工作区解析和远端恢复都保持原样。daemon 网关只在驱动请求者 Session 的那个 Turn 仍活跃时放行，因此比 Turn 活得更久的进程不能继续使用这些工具。本地平台另外保留单用户环境，并要求该 Turn 的请求者是本地用户；Cloud 中共享机器上可能是协作者在驱动 Session。
- 借用副本的命令从不清理 daemon 的副本，因此命令结束时不再有可能失败的释放步骤。
- 资源发现读取 daemon 缓存，不强制每次追平。metadata、工作区与授权机器目录共用一次一秒的首次 baseline 等待预算；超时不取消 daemon reader，而是让本次结果保持未确认：列表附带 `sync.state: syncing`，依赖目录的负面判定改为 `unknown/catalog_syncing`，缺少 get 结果返回可重试的 `CATALOG_SYNCING`。已完成 baseline 的目录不再等待。Role 提议的目标校验复用了 discovery，因此显式选择 fresh 模式：同步 metadata，并在访问校验后同步唯一目标 Machine Flock，要求远端确认；失败保留原始 cause 并返回可重试错误，不发布提议。普通读取、独立 CLI、鉴权与分发契约各自保留。
- #1713 之后最初使用纯 Promise room helper 修复兼容性，因为原生兼容层已撤回，不能调用 `runLegacy`、`acquireScopeLegacy` 或 `.native`。[后续修正](../bug-fix/2026-10-19-promise-repo-catalog-readers.zh.md)替代该临时 helper：在同一 Promise Repo 上用 Scope 管理 room 与副本 lease，后台重试 acquisition/屏障，并在销毁 Repo 前显式关闭 reader。上述冷读取与 fresh validation 约定不变。测试现已覆盖真实 Promise 产品与 manager/MCP 边界；尚未验证生产 Streams。
- Roost 历史始终留在 Session 的所属机器。一次性 manager 对每个 Session 都注入 owner RPC，而 daemon 安装的 Roost owner 是本机数据库。因此 Cloud daemon 的 manager 按 Session 路由：其他机器的 Session 使用同一套 owner RPC 服务，本机的 Session（或所属机器尚未知的）继续使用本地 owner。该路由独立于 `sessionHistoryFactory`，daemon 自己的执行文档保持原有的自动已读策略。缺少它时，读取其他机器的 Session 会得到空历史，新输入被写进调用方的数据库，所属机器收到 dispatch 后找不到消息。这同样覆盖 daemon 的 Cloud Operation 恢复，它调用的是同一套 create 与 chat 路径。
- MCP 的取消和归档改为调用共享的进程内函数，不再启动会自建副本的子 `lody` CLI。
- 释放失败永远不阻塞工作区。接纳替换者之前，presence 注册表先等上一个 owner 的停止流程结束，新流不会与未完成的释放重叠；若释放失败，该 owner 退役：残留工作仍归应用根 Scope 所有，退出时照样被停止，且之后每次申请 owner 都会在后台重试它，直到释放成功。两个存活 owner 仍被禁止。`cleanUp` 即使前面的步骤失败也会停止 presence，不会留下存活 owner。独立命令池对清理失败只报告一次（报告器抛错会被忽略），并总是移除条目。

## 考虑过的方案

- **先重试失败的释放，再放行下一条命令。** 这是最初考虑的修法。网络持续失败时它仍会阻塞，保留了它本想消除的故障。
- **在 MCP 进程里缓存一个空闲 manager。** 能减少清理次数，但每个工作区仍在 daemon 之外多一份副本、presence owner 和 token owner。
- **为 renderer 与 daemon 统一数据 owner。** [WorkspaceData services](../../proposed/architecture/2026-10-14-workspace-data-services.zh.md) 提议了这一更大的改动。本次变更与之兼容：去掉一份重复副本，但不替它选定进程拓扑。

## 取舍与限制

- Cloud MCP 工具的工作现在跑在 daemon 事件循环上，包括 operation store 的同步 SQLite 调用。OSS 自 #1133 起即如此；MCP 进程仍是协议适配层，因此没有把这部分挪回去。
- 路由后的调用依赖 daemon。调用 Lody MCP 的 agent 本身就运行在 daemon 管理的 Session 中，所以没有新增可用性依赖。路由后的调用沿用子 CLI 路径的十分钟上限，只有旧式 `wait: true` 调用在其最长等待之外再加这十分钟；此前 OSS 的上限是 30 秒。local-control 协议不携带取消，被放弃的调用仍会在该上限内于 daemon 中执行完；OSS 原本就是如此。
- 旧 owner 的工作仍被保留时就接纳替换者，旧流的迟到写入可能到达。presence 是最新状态，TTL 90 秒、心跳 30 秒，零星条目会自愈；durable 数据不受影响。
- 终端独立运行的 `lody` 命令仍打开短生命周期副本，因为那里不保证有 daemon；它们的失败不再阻塞后续命令。`lody_session_share` 留在 MCP 进程，因为它需要 MCP 请求的 abort signal，且不使用工作区副本。

## 验证

- 新的归属测试 `daemon-session-tools.test.ts` 在 Cloud 组合下使用真实 `LoroDocumentManager`：MCP 客户端调用经真实 local-control socket 到达 daemon；协作者的请求在 daemon 副本上执行；嵌套命令借用该副本且不销毁它；超出 daemon 工作区或机器范围的调用被拒绝。
- `loro-document-manager-create.test.ts` 的清理失败用例新增了经原生注册表的真实 presence 释放失败。恢复旧注册表后，该用例以用户报告的 `Workspace presence operation failed` 失败。
- `presence.test.ts` 检查原生注册表：拒绝存活的重复 owner；替换释放失败的已停止 owner；后台重试失败后，之后的申请会再次重试直到释放；释放进行中时申请的替换者会等旧流结束。恢复旧注册表后替换测试同样失败。
- 文档管理器测试还让 data-plane 释放在 presence 停止前失败；去掉 `cleanUp` 中的保护会留下存活 owner，下一条命令失败。
- daemon 测试还会拒绝 Turn 已结束的调用，以及登录身份与 daemon 不再一致的借用命令。
- 资源发现回归测试保存真实 Role/config Flock 数据，并注入 metadata/Flock 同步失败。修正前，daemon handler 返回报告中的 `resource.discovery`/`--offline` 错误或 Flock 错误；修正后，list/get 返回活跃协作者的私有 Role 和配置。本地 daemon 读取也成功，独立 CLI 同步失败仍明确报错，离线查询能读取缓存。Cloud 授权在访问边界使用测试替身；这不能证明报告问题的机器已经恢复。
- `roost-session-backend-contract.test.ts` 经真实安装的本地 Roost owner 路由：daemon 本机所属的 Session 读取本地历史，其他机器所属的 Session 的读写都走 owner 路由。让路由总是使用本地 owner 会使该测试失败。
- 命令池测试证明清理失败只报告一次，等待中与之后的命令都不被阻塞，报告器抛错既不改变已接受的结果，也不影响之后的命令。已删除被移除的子 CLI 取消路径对应的参数形状测试。
- CLI 类型检查、类型感知 lint、Effect lint，平台、进程、presence、公开边界、本地写入器、inbox 与 Code Collab 边界检查，以及 MCP、session、schedule、zero-cloud 与 presence 测试均通过。未运行打包应用、线上 Cloud 与真实 agent 端到端测试。

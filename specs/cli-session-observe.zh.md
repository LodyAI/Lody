# CLI Session 观察

Status: draft
Translation: current

[English](cli-session-observe.md)

## 场景与职责

终端程序提交一轮任务而不等待，然后附着到 Session 查询结果并跟踪后续工作。
observe 读取 Lody 保存的同一份事实，不执行任务、不确认消息已读、不回答权限请求，
也不接管 Session 生命周期。本次沿用现有 Cloud CLI 的认证与 Streams 路径，
尚不支持仅通过本地 daemon 附着。

```sh
lody session observe <sessionId> --jsonl --follow
lody session observe --workspace <selector> --all --jsonl --follow
lody session observe <sessionId> --json
```

不传 `--follow` 时返回快照后退出；follow 必须配合 `--jsonl`。
`--json` 与 `--jsonl` 互斥。单 Session 可回退到 `LODY_SESSION_ID`；
`--all` 必须显式指定 workspace，拒绝位置参数 Session ID，并忽略该环境变量。
Workspace 可用 ID、slug 或名称选择。不提供离线 follow，也不自动回退到过期缓存。

## JSONL 合约，版本 1

每条成功事件含 `version: 1`、`streamId`、`sequence`、`observedAt`（Unix 毫秒）
和 `workspaceId`。Sequence 从 1 开始，为同一命令进程内所有 Session 的事件排序。
它不是持久化游标、跨进程身份、原始执行时间或重放保证。

| Type              | 载荷与含义                                                                     |
| ----------------- | ------------------------------------------------------------------------------ |
| `snapshot`        | `sessionId`、`session`：新观察来源的基线。                                     |
| `ready`           | 可选 `sessionId`：单 Session 初始读取或 Workspace 目录枚举完成。               |
| `session.changed` | `sessionId`、`session`：有意义的投影状态发生变化。                             |
| `turn.started`    | `sessionId`、`userTurnId`、可选 `assistantTurnId`：观察到进入运行状态。        |
| `turn.finished`   | 同样的身份，加 `outcome: completed \| failed \| canceled`、可选 `durationMs`。 |
| `session.removed` | `sessionId`：元数据确认删除。归档是变化，不是删除。                            |

`session` 含 `sessionId`、`machineId`、可选 `title`、`archived`、`state`、
`freshness`、`source`、可选 `latestTurn` 和 `activeTurns`。
Session 状态为 `idle | pending | running | waiting | unknown`。
每轮含 `userTurnId`、可选 `assistantTurnId`，
`state: pending | running | unknown | completed | failed | canceled`，
以及存在 Assistant 时的可选终态 `durationMs`（计时不可用时为 0）。

```json
{
  "type": "snapshot",
  "version": 1,
  "streamId": "example",
  "sequence": 1,
  "observedAt": 1791417600000,
  "workspaceId": "w1",
  "sessionId": "s1",
  "session": {
    "sessionId": "s1",
    "machineId": "m1",
    "archived": false,
    "state": "idle",
    "freshness": "synced",
    "source": "persisted",
    "latestTurn": { "userTurnId": "u1", "assistantTurnId": "a1", "state": "completed" },
    "activeTurns": []
  }
}
```

快照包含最新一轮结果，即便任务很快完成、程序随后才附着，也能读取结果。
已有历史只建立基线，不重放 `turn.started` 或 `turn.finished`。
两次读取之间完成的任务可以直接出现终态而没有已观察到的开始事件。
显式重新打开 Assistant 后，同一组 ID 可以再次发生运行、结束转换。

`--json` 单 Session 返回 `{ok: true, version: 1, workspaceId, session}`，
Workspace 返回 `{ok: true, version: 1, workspaceId, sessions}`。
结构化观察期间诊断日志写 stderr。命令失败沿用 CLI 现有格式：
JSONL `{type: "error", error: "..."}` 不带版本化 envelope，
或 JSON `{ok: false, error: "..."}`，随后以非零状态退出。
消费者必须同时处理错误记录、进程退出与正常事件。

## 证据与新鲜度

完成需要 User 为 `handled`，且关联 Assistant 为 `finished: true` 或含数值 `endedAt`。
User 的 `failed`、`canceled` 分别独立证明对应终态，支持尚无 Assistant 的失败。
元数据 idle、取消 ACK、Presence 消失或机器断线都不能证明一轮任务结束。
当元数据的 `latestUserMsgId` 或 `processingUserMsgId` 指向尚未在历史中确认终态的任务，
上一轮结果不能使 Session 变为 idle，也不能释放其 Workspace 订阅。
`waiting` 表示运行中的任务存在持久化权限等待状态，不输出或回答权限载荷。

`source: persisted` 表示读取了历史目录标量与控制状态。
`source: metadata` 是低成本目录投影，始终为 `state: unknown`，不包含任务证据。
`freshness: synced` 表示读取经过同步确认，不证明 daemon 存活，也不保证所有房间持续连接。
已附着历史房间断线时，新鲜度变为 `unavailable`，保留此前任务状态并抑制终态事件。
元数据与文档追赶同步确认后恢复新鲜度并核对结果。
首次同步失败或不可恢复读取错误使命令失败，不能转成完成或删除。

## Workspace 成本与观察边界

一个进程、一条元数据 watch 发现 Session，包括已归档元数据。
先安装 watch 再枚举，枚举期间的变化在目录 `ready` 前重新核对。
该标记不意味着每个历史房间都已打开；消费者通过各快照的 `source` 判断来源。

历史 idle 房间不打开。Follow 打开活跃、待派发、新建或最新任务身份发生变化的 Session，
同时打开文档的并发上限为 4。这限制获取并发，不限制同时活跃的 Session 数量。
读取到新鲜、持久化终态证据后才释放房间，而且只释放 observe 自己拥有的资源。
之后的目录编辑保留最后观察到的结果。
未打开的 idle 房间中，仅历史正文变化或未伴随激活元数据变化的任意重新打开行为，
不属于 Workspace follow 范围；需要持续观察时单独附着该 Session。
一次性 Workspace 输出仅为元数据目录，不打开历史房间。

普通流式文本、工具输出不产生逐 token 事件；增量标量读取、串行刷新与投影比较合并变化。
这是持久化事实观察，不是无损运行事件日志。重启或出现缺口后应核对快照、历史，
消费者自行保存所需事件缓冲。现有 `create/chat --wait --jsonl` 和有限
`history --jsonl` 的格式不变。

SIGINT/SIGTERM 停止观察并释放订阅，不取消执行。
单 Session 被删除后 follow 结束；Workspace follow 继续。
输出有序、等待背压，排队输出上限为 1 MiB。
管道断开或来源错误结束观察并触发清理。

## 证据与验证限制

- [命令与进程职责](../apps/cli/src/commands/AGENTS.md)。
- [投影、增量读取与输出](../apps/cli/src/commands/session-observe.ts)、
  [作用域适配](../apps/cli/src/commands/session-observe-runtime.ts)、
  [Workspace 目录](../apps/cli/src/commands/session-observe-workspace.ts)。
- [确定性事件测试](../apps/cli/src/commands/session-observe.test.ts)与
  [真实持久化文档只读测试](../apps/cli/src/commands/session-observe-runtime.test.ts)。
- [实现决策](../.agents/notes/implemented/feature/2026-10-08-cli-session-observe.zh.md)。

针对性测试覆盖事件语义、竞态、缓冲、清理与只读打开。
尚未验证真实认证 CLI/provider 执行或外部 Connector 联通。
本翻译 Spec 仍为草案。

# Plan 001：以原子操作替代 Session archive 补偿

> 执行 Agent：先完整阅读本计划，再按阶段实施。每阶段返回 diff、实际命令和可复现结果；
> 主控负责架构取舍与最终验收。本计划没有授权 push、修改 PR、关闭 Issue 或启用不兼容协议。
> 先执行下面的漂移检查；发生漂移时对照现有代码与摘录修订计划，不能机械套用行号。

## 状态与目标

- Priority: P1；Effort: L；Risk: HIGH；Category: correctness / architecture。
- Planned at: `54623883be77bd17f9dab18ef5a60cc2a9b156ef`，2026-09-13。
- Depends on: 无其他计划；生产启用依赖本计划中的存储与兼容性门槛。
- 工作对象：[Issue #574](https://github.com/LodyAI/Lody/issues/574) 与
  [PR #658](https://github.com/LodyAI/Lody/pull/658)。当前分支为 `fix/archive-hydration-bounded-wait`。
- Intent：[Session relations](../specs/session-relations.md)。
- Rationale：[原子 lifecycle 提交提案](../.agents/notes/proposed/architecture/2026-09-13-session-lifecycle-commit.md)。

一次 root archive 或 restore 必须以同一个操作覆盖它的冻结目标集。提交前失败不能留下
本次变更；提交后的确认失败不能恢复旧快照。兼容副本可以在不同时间收到操作，但同一
有效状态快照不能暴露该操作只应用了一部分。单独归档 Tab 仍合法。

## 当前实现与可保留部分

| Owner                                                           | 当前职责与问题                                                                               |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/components/src/hooks/use-session-actions.ts`          | repository discovery 已修正冷启动漏 child；archive 仍逐条写入和补偿，restore 仍查 UI cache。 |
| `packages/components/src/providers/workspace-writer{,-impl}.ts` | 所有 renderer 本地 author；`upsertDocMeta` 只转发单次 repo 调用。                            |
| `packages/components/src/atoms/doc-meta.ts`                     | 本地 patch 逐 doc 立即发布；远端 patch 有大小限制的分批发布。                                |
| `apps/cli/src/commands/session.ts`                              | CLI archive/restore 对 root 和 children 并行调用单 doc writer；MCP archive 复用该命令。      |
| `apps/cli/src/lib/message-handler.ts`                           | 观察单 Session archive 后释放 runtime；另有 local-project removal 的逐条 archive writer。    |
| `packages/shared/src/schema.ts`                                 | `SessionMeta.isArchived` 是可选布尔值，尚无 lifecycle operation 契约。                       |
| `patches/loro-repo.patch`、`pnpm-lock.yaml`                     | 固定依赖与补丁；现有 patch 只修复 metadata live monitor 启动。                               |

漂移检查：

```sh
git diff --stat 54623883be77bd17f9dab18ef5a60cc2a9b156ef..HEAD -- packages/components packages/shared apps/cli patches/loro-repo.patch pnpm-lock.yaml specs/session-relations.md
git status --short
```

关键现状摘录，来自 `use-session-actions.ts:280` 与 `:311`：

```ts
attemptedTargets.push(session);
await runtime.writer.upsertDocMeta(getSessionRoomId(session.id), {
  isArchived: true,
  status: SessionStatusFactory.idle(),
});
// 失败后的另一次 authored write：
await runtime.writer.upsertDocMeta(getSessionRoomId(session.id), {
  isArchived: session.isArchived,
  status: session.status,
});
```

第二段的值来自先前 snapshot，不代表当前值由本操作拥有。失败期间另一个 writer
修改状态后，这段补偿会产生新的 CRDT 写入覆盖它。

保留 repository discovery 的思路、仅 direct `parentSessionId` 的目标规则、workspace
切换边界、独立 `openedBy*` Session 不受影响、提交后 best-effort terminal cleanup。
删除 snapshot compensation、children/root 排序作为正确性基础、`attemptedTargets`、
`rollbackErrors`，以及 rendered cache 作为生命周期提交依据。

## 已知依赖能力，不得扩大解释

`loro-repo@0.20.0` 的 metadata 使用 `@loro-dev/flock-wasm@0.4.3`，字段位于同一个
meta Flock 的 `m/docId/field` key。真实内存实验已观察到 WASM 同步 transaction 抛错时
撤销数据、事件和导出变更，但 `@loro-dev/flock@4.4.4` 的同名 API 不撤销数据。
WASM 文档与二进制还存在该语义差异，必须用行为测试锁住具体版本。

`getMeta().txn` 不能直接替代应用 writer：原始值改变后，LoroRepo 的已加载 cache
仍可保持旧值；远端整批 import 又会逐 doc reconcile，向 watcher 暴露中间状态。
字段各自拥有 CRDT 时钟，多 key transaction 没有整体冲突决胜保证。
`upsertDocMeta` 不等待落盘；`persistMetaNow` 是另一个边界。

可复现的基线探针：[inspect-lifecycle-boundaries.cjs](support/inspect-lifecycle-boundaries.cjs)。
在已安装依赖的 clone 中运行：

```sh
node plans/support/inspect-lifecycle-boundaries.cjs packages/components/package.json
```

它应 exit 0，并报告 `peerUpdatePreserved: true`、`exportUnchanged: true`、本地 raw/cache
分别为 `[true,true]` / `[false,false]`，远端 watcher 曾看到 child/root 不一致。
这些断言描述旧依赖的局限，不是修复验收；升级后行为变化必须重新评估。
可传另一个显式 package.json 路径定位已安装的同版本依赖，不安装或修改该依赖目录。

Frontend runtime 在 `create-workspace-runtime.ts:416` 显式设置
`metaDebounceCommitMs: 0`。默认 debounce 与 `txn` 互斥不是这个 runtime 的直接阻碍。
事务内禁止 async、Promise 回调和 import；import 可能先提交再报错。

## 选择的操作模型

以一条完整、不可变的 JSON record 表达一次操作，存储 key 由 repository adapter 管理。
以下是待原型验证的 v1 数据形状，字段名称可以在同一阶段调整，语义不可省略：

```ts
type SessionLifecycleOperation = {
  version: 1;
  operationId: string;
  subjectId: SessionId;
  targetIds: readonly SessionId[];
  state: 'archived' | 'active';
  order: { counter: string; actorId: string };
};
```

- `targetIds` 来自同一次 repository discovery，去重后冻结，必须包括 subject。
  root 操作包含所发现 direct children；Tab 单独操作只有该 Tab。不包含 `openedBy*`。
- 使用单 key、完整 JSON value 的写入。禁止把 record 用自动展开对象的 API 拆成多个 key，
  也禁止靠多 key 的 `pending/committed` 标记拼出未经证明的原子性。
- 操作按不可变 id 保留，不能让一个可变 root record 的整对象替换丢掉尚未同步的操作。
  重试复用相同 id、排序和 payload；同 id 不同内容属于协议冲突，不能任选一份继续。
- 提议采用 Lamport 顺序：新操作的 counter 大于当前已观察到和本地已预留的 counter；
  序列化为规范非负十进制字符串，用数值比较，禁止按字符串排序或依赖墙钟。
  同 counter 时按 actorId、operationId 的稳定字节序决胜。重试绝不提升排序。
  同一 workspace/store 的 counter 分配与 record 持久化接纳必须串行化；共享存储的多个
  tab/process 需要存储事务或等价协调，不能仅靠进程内变量。启动先恢复已发布与已接纳
  未发布记录的 high-water mark，再开放新命令；不能只扫描已发布的 Flock 状态。
- resolver 对每个目标选取覆盖它的最高顺序操作；一个 root 操作的排序对所有目标相同。
  固定目标集上的两个 root 操作整体决胜，较新的 singleton Tab 操作只覆盖该 Tab。
  反过来，较新的 root 操作覆盖它所包含的旧 singleton。两个 root 操作的冻结集合不同
  时，共有目标由较新操作决定，不在较新集合的目标保留最后一个覆盖它的操作结果。
  这是明确的操作顺序，不承诺对未观察到的远端操作具备真实时间线性一致性。
- 从完整 record 计算所有受影响目标，再一次发布有效 metadata revision。`isArchived`
  是该投影的结果，不能同时保留另一套独立 author 的权威 flags。
- lifecycle 操作不写回或伪造 runtime `status`；实际终止后由既有 runtime owner 发布 idle。
  初次创建 Session 的未归档初始化是 baseline，不等同于 archive/restore 命令。
- deletion/existence 优先：operation 不创建、不复活已删除或未知的 Session。冻结目标里
  尚未到达的 metadata 可以保持未知，之后 hydration 必须使用同一个 resolver。
- v1 不清理 operation 历史。建立按目标索引与增量投影；不在每次组件 render 全量重放。
  记录增长成本与后续 checkpoint 条件，不能在没有离线副本保留契约时按时间删除记录。

这个模型需要原型与契约评审后才能冻结 wire format。它限定于 archive/restore，不能扩成
通用 Operation 调度器、worker supervision 或新的云端服务。

## 提交、持久化与恢复

```text
discovery / validation
  -> durable admission of one immutable record
  -> publish effective revision and replicate
  -> reconcile current resource state
```

repository adapter 必须说明谁持久化 record、谁允许它进入实时投影和同步流、失败由谁接管。
优先复用具备提交前隔离与落盘边界的 repository 能力；当前 `put; await persistMetaNow()`
会先发事件，不能直接当成已证明的 durable admission。

若依赖不能延迟发布，需要受测试保护的 dependency 扩展，或在既有本地存储中原子写入
该 record 的专用 admission journal，再按同 id 发布。journal 只保存生命周期提交依据，
不是回滚快照或另一套任务调度队列。必须先完成 IndexedDB/SQLite 适配原型与恢复测试，
才确定生产存储布局；不要让执行 Agent 猜测底层 transaction 的保证。

| 失败位置                             | 必需结果                                                           |
| ------------------------------------ | ------------------------------------------------------------------ |
| 验证或持久化接纳之前，且确认没有接纳 | 没有本次有效状态、同步更新、terminal effect；可报告 rejected。     |
| 存储调用结果不确定                   | 返回可查询的同一 operationId；不能谎称零写入，也不能 author 补偿。 |
| record 已持久化，发布或回复失败      | 返回/恢复同一提交；启动重放、重连、重复请求都不新建操作。          |
| 同步或资源清理失败                   | 保留 lifecycle 事实，由同步/资源 owner 重试，不恢复旧状态。        |
| 本操作已被较新操作覆盖               | 保留历史身份；重试不提升排序，不重放过期 teardown。                |

进程重启只能恢复已经持久化的依据。存储不可用期间不能承诺尚未落盘的操作跨重启存活。
UI 导航、terminal cleanup 和 CLI 成功响应以明确的 durable receipt 为依据；同步确认另行
呈现。发布与重放采用至少一次交付：同 operation/revision 可重复通知，不能承诺跨崩溃
exactly-once 事件。订阅携带稳定 operation 身份与可识别的 lifecycle revision；重复交付
不能成为新逻辑操作、提升排序或重复破坏资源。分别测试落盘后发布前、发布后记录完成前
崩溃；恢复时按完整已知操作集重算当前 revision，不强制逐条通知已经过期的中间态。

watcher 和资源执行点重读当前有效状态，并与同一 Session 的 start/resume 协调：排队的
旧 archive 不得作用于 restore 后的新 runtime generation。跨 await 的 teardown 必须
绑定捕获的资源实例/代次或使用等价串行化约束；只在开始时检查一次布尔值不足以证明安全。

## 模块边界与修改范围

| 层               | 计划修改范围                                                                                                                                                                                                     | 责任                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 共享契约         | `packages/shared/src/session-lifecycle.ts`、`packages/shared/tests/session-lifecycle.test.ts`（新增），必要的 exports/schema                                                                                     | parser、排序、纯 resolver、结果类型；平台中立。                                                  |
| repository 接缝  | `packages/shared/src/session-lifecycle-repository.ts`、`packages/shared/tests/session-lifecycle-repository.test.ts`（新增）；必要的 `patches/loro-repo.patch`、catalog/manifest/lock                             | 平台中立的接纳、恢复和完整 revision 发布 owner；注入实际存储 port。                              |
| IndexedDB 持久化 | `packages/components/src/lib/session-lifecycle-persistence.ts`、`packages/components/tests/session-lifecycle-persistence.test.ts`、`packages/components/tests/e2e/session-lifecycle-persistence.spec.ts`（新增） | 使用实际 browser 存储验证 durable admission 和跨 reload 恢复；不以 fake IndexedDB 作为最终证据。 |
| SQLite 持久化    | `apps/cli/src/lib/loro/session-lifecycle-persistence.ts`、相邻 `session-lifecycle-persistence.test.ts`（新增），必要时扩展 `sqlite-repo-store.ts`                                                                | 沿用隔离 workspace 存储命名空间，验证真实 SQLite 接纳、关闭重开与 replay。                       |
| renderer         | `workspace-writer.ts`、`workspace-writer-impl.ts`、`create-workspace-runtime.ts`、`atoms/runtime.ts`、`atoms/doc-meta.ts`、`use-session-actions.ts`                                                              | 注入统一 owner，替换 archive/restore，原子更新 cache；释放 workspace 时保留已接纳责任。          |
| CLI/runtime      | `apps/cli/src/commands/session.ts`、`lib/loro/doc.ts`、`lib/message-handler.ts`、`session/session-dispatch-watcher.ts`、`session/session-execution-service.ts`                                                   | 命令与 local-project removal 走同一 writer；查询、dispatch、resume、GC 读有效状态。              |
| 其他消费者       | `providers/background-sync-coordinator.ts`、CLI list/show、MCP summaries、归档 UI 的必要读取接缝                                                                                                                 | 接收统一投影，不在各消费者复制 resolver。                                                        |
| 测试与文档       | 上述 owning suites、`specs/session-relations*`、本提案、受影响 README/AGENTS                                                                                                                                     | 行为证据和正确的实施状态。                                                                       |

遵守根和各 scoped AGENTS；涉及 protocol capability 时读 `packages/shared/AGENTS.md`。
shared 不依赖私有包或 hosted API。每个客户端继续 author 自己的 repo，不恢复 daemon proxy。
不要逐组件添加 fallback；通过明确的 repository metadata reader 契约让现有消费者获得
统一结果，并在迁移清单中核实所有 raw reader。访问 raw fields 的必要场景必须显式命名。

不在范围内：永久删除的事务化、nested child、snapshot 后创建 child 的完整性保证、#529、
worktree GC 策略重写、真实用户数据迁移实验、私有 Web/mobile 源码、运营准入配置。
实现发现必须修改新的 owner 时，先更新此处具体范围与理由，再由主控判断。

## 执行阶段与验证

### 1. 固定依赖能力与失败证据

在 owning writer/cache suite 中建立真实 WASM 与 LoroRepo 的确定性 fixture，保留现有 cold-start
discovery 用例。使用可释放 Promise gate、注入时钟与 synthetic metadata，不用真实 sleep。
先记录旧实现的两个反例：第三方更新后 pre-mutation reject 覆盖状态，以及 child 补偿失败。
另测 raw txn/cache 不一致和远端逐 doc publication，避免修复只通过 fake repo。

运行下方组件命令。旧实现应在指定新 regression 上失败；已有行为测试仍通过。
提交证据必须能区分 baseline 失败与测试环境缺依赖。随后实现应让这些 regression 转绿，
不能删除断言以获得通过。

### 2. 验证操作模型、两种存储与切换门槛

新增共享 parser/resolver 测试，覆盖验收矩阵中的排序、成员集、未知与删除目标。
按上述明确路径分别做 IndexedDB 和 SQLite 最小持久化原型；两者都注入写前失败、已存后
返回失败、发布前重启、发布后重放，不能只证明第一个 adapter。验证并发本地接纳的 counter
分配，以及已接纳未发布后重启、新操作的顺序。证明 reader 只看到完整 revision，并保留
第三方无关 metadata 和 status。冻结 record keyspace、完整 JSON 编码、API/result、order
和本地持久化布局，写回 owning Note。

在接入生产之前确定可执行的 baseline/旧 writer 策略及启用机制。明确哪些拓扑可以协调
切换，哪些仍被阻断；用遗留 writer 与离线重连 fixture 验证，而不是只写一个 feature flag。
这个阶段的新路径保持未启用，现有生产路径暂留且仍标记为未修复；不得先删除旧路径，
之后才发现新协议无法启用。没有一条长期双权威的过渡实现。

运行 shared、两种 persistence 与组件命令，全部通过。浏览器用 owning Playwright suite 的
Vite 模块加载方式运行真实 adapter；隔离数据库名，关闭/reload 后重建 owner，不模拟落盘。
单 record 已足够时不另造通用多 doc transaction API。
若依赖修改必要，需附源码来源、版本、生成方式和发布/patch 路径；禁止只改 node_modules。
不能完成这个阶段的原子性、两种持久性与可执行切换证明时，不开始切换生产调用点。

### 3. 迁移同一权威的生产者与消费者

同时替换 renderer/CLI archive 与 restore；MCP archive 复用 CLI，无需新增远程 author。
local-project removal 保留原有重试/资源责任，但每个生命周期操作走新 writer。
初始未归档 baseline 保留，普通 status producer 不参与旧值恢复。

本地与远端投影都整批安装再通知。把 `getDocMeta`、list/scan、watch、UI atom、daemon
dispatch/resume/GC 的读取接缝逐一纳入一致性测试，不能只改变 sidebar 的显示。
先在满足阶段 2 门槛的隔离拓扑中协调切换所有 writer/reader，再移除该拓扑的旧路径；
在授权的生产发布前完成阶段 4 验收。删除旧 helper 及依赖补偿顺序的断言，以提交结果、
最终状态与可观察 revision 代替。若支持的拓扑尚不能一起迁移，不发布一个缺失可用路径的
中间版本，也不能把保留旧路径的拓扑记为已修复。

运行组件、shared、CLI owning suites 与公共边界检查。`rg` 检查旧 helper 应零命中；
剩余 `isArchived` 写入逐处分类为初始化、兼容性入口或错误绕过，不能仅凭字符串数量验收。

### 4. 兼容性与产品验收后启用

复核阶段 2 已证明的切换机制：旧布尔值必须在明确的迁移边界成为 baseline。新格式启用后，不得继续接受无法表达同一
操作的旧 flags 为并列权威。需要在实际 writer 准入边界处理旧 renderer、daemon 和离线重连，
或者有覆盖所有参与者的协调升级方案与证据。缺少该机制时保持新格式未启用，报告缺口。

`MachineMeta.protocolCapabilities` 只描述 daemon，不能证明所有 renderer 都支持新格式。
当前公开源码没有足够机制证明产品所有客户端已迁移。本计划不授权修改 hosted 准入服务。
本地 OSS 拓扑和产品多客户端拓扑分别验收，不能互相代替。

先执行 owning suites 和全量 checks，再用两个隔离 runtime、真实持久化与同步通道验收：
故障 gate 保证动作交错，重启复用隔离数据目录，结果用结构化状态而不是 toast 判定。
覆盖既有 `LODY-SESSION-004` target/discovery 行为；新的故障用例放入 owning journey/fixture，
即 `e2e/src/features/session-management.feature`、
`e2e/src/support/fixtures/session-relation-lifecycle-fixture.ts` 和
`e2e/src/support/pages/session-relation-lifecycle-page.ts`。需要新 scenario 时同步
`e2e/journeys/registry.json`，遵循 `e2e/AGENTS.md`。禁止使用真实 workspace 数据。
该桌面验收证明 OSS 拓扑，不能替代私有 Web/mobile 的产品发布证据。

## 验收矩阵

| 场景                                            | 必须观察到的结果                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| snapshot 后另一 writer 改 child，本次提交前失败 | 另一方的 archived/status/无关字段保持；没有本次导出变更和事件。              |
| 第 N 个目标计算或验证失败                       | 未持久化/发布任何部分 operation；不存在 child rollback 需求。                |
| durable write 已接受但返回失败                  | 查询同 id 与重启确认同一提交；允许重复交付，不产生新操作、新排序或重复破坏。 |
| durable record 后、projection 前崩溃            | 重启完整重建所有目标；没有需要人工修复的 flags 分裂。                        |
| projection 后、完成标记前崩溃                   | 同操作 replay 幂等；所有订阅与资源效果能处理重复通知。                       |
| 本地并发接纳、接纳未发布后重启再发命令          | 分配与持久化串行；新 counter 高于所有本地已接纳及已观察值。                  |
| 已落后于新 restore 的 archive 重放              | restore 不被覆盖，旧 teardown 不执行。                                       |
| teardown await 期间 restore 并启动新 runtime    | 旧任务不销毁新资源代次；检查发生在真实异步资源边界。                         |
| 两个 root archive/restore 并发，固定成员集      | 合并顺序与重复交付不改变全体目标的同一胜者。                                 |
| root 操作与较新 singleton Tab 操作              | 只有 Tab 被后者覆盖；其他目标一致，root worktree 不受 Tab 单独操作支配。     |
| 旧 singleton 后收到较新 root 操作               | root 操作覆盖该 Tab；不存在 singleton 永久压过父操作的特殊规则。             |
| 相同 counter、不同 actor/id；重复和反向交付     | 所有副本遵循同一稳定比较顺序；最终状态与到达顺序无关。                       |
| 两个 root 操作使用不同冻结集合                  | 共有目标取较新操作；集合外目标保留最后覆盖值，不补写未选中的目标。           |
| 本地/远端 watch、get/list 与 UI revision        | 每个已发布 revision 都来自完整操作集，不暴露逐目标安装中间态。               |
| cache 缺 root、只渲染了 root、workspace 切换    | 权威查询决定是否可提交；已接纳操作不被新 workspace 接管。                    |
| 旧 writer、离线回归、未知 schema version        | 按明确兼容策略拒绝/隔离或迁移；不能静默双写降级。                            |
| 同步中断、runtime/terminal 清理失败             | durable operation 保持，恢复后收敛；无 metadata compensation。               |

## 命令与环境

Node 22+，pnpm 使用根 `package.json` 固定版本。当前 nested worktree 没有 node_modules，
组件测试曾因 `vitest: command not found` 未执行。不要在 nested checkout 安装；需要完整
workspace 验证时使用独立 clone 并按仓库要求初始化授权的 submodules、安装固定依赖。
借用恰好匹配的依赖只能用于说明其版本的 isolated probes，不能冒充全量 typecheck。

| 用途               | 命令                                                                                                                                                                                  | 成功结果                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 开始文档检查       | `pnpm run docs status`                                                                                                                                                                | 记录 baseline；当前有 20 个未初始化 submodule 链接错误。     |
| 组件行为           | `NODE_ENV=test pnpm --dir packages/components test tests/use-session-actions.test.ts tests/workspace-writer.test.ts tests/doc-meta-subscription.test.ts tests/doc-meta-batch.test.ts` | 修复完成后所有用例通过。                                     |
| 共享模型与 owner   | `pnpm --dir packages/shared test tests/session-lifecycle.test.ts tests/session-lifecycle-repository.test.ts`                                                                          | 新增模型与恢复行为全部通过。                                 |
| IndexedDB 接缝     | `NODE_ENV=test pnpm --dir packages/components test tests/session-lifecycle-persistence.test.ts`                                                                                       | 注入故障与 API 契约通过，不替代真实浏览器存储。              |
| 浏览器实际持久化   | `pnpm --dir packages/components test:e2e tests/e2e/session-lifecycle-persistence.spec.ts`                                                                                             | 真实 IndexedDB 的失败、重复交付和 reload 恢复通过。          |
| SQLite 实际持久化  | `pnpm --dir apps/cli test src/lib/loro/session-lifecycle-persistence.test.ts src/lib/loro/sqlite-repo-store.test.ts`                                                                  | 隔离 SQLite 的失败与关闭重开恢复通过。                       |
| CLI 资源边界       | `pnpm --dir apps/cli test tests/message-handler-terminal-cleanup.test.ts tests/worktree-gc.test.ts`                                                                                   | 原有资源语义与新恢复行为通过。                               |
| CLI 命令           | `pnpm --dir apps/cli test src/commands/session.test.ts`                                                                                                                               | 既有 archive/restore 与新 writer 结果契约通过。              |
| 实际 repo 同步边界 | `pnpm --dir apps/cli test tests/loro-native-multi-transport.integration.test.ts tests/loro-doc-unload-data-plane-integration.test.ts`                                                 | 双副本 owning suite 与新增故障、恢复场景通过。               |
| 类型               | `pnpm --dir packages/shared typecheck`、`pnpm --dir packages/components typecheck`、`pnpm --dir apps/cli typecheck`                                                                   | 正确依赖环境中 exit 0。                                      |
| 公共边界           | `pnpm check:public-boundary`                                                                                                                                                          | exit 0；无 private/cloud/local 边界变化。                    |
| E2E 定义           | `pnpm e2e:check`                                                                                                                                                                      | journey registry、scenario 与 fixture 一致。                 |
| 桌面产品场景       | `pnpm e2e:build` 后 `pnpm --dir e2e exec cucumber-js --config cucumber.mjs --tags '@LODY-SESSION-004'`                                                                                | 隔离的真实桌面/CLI 运行时完成目标、故障与恢复验收。          |
| 桌面 smoke         | `pnpm e2e:smoke`                                                                                                                                                                      | 构建后既有 P0 场景通过。                                     |
| 提交前             | `pnpm check`、`pnpm format`、`git diff --check`                                                                                                                                       | 完整检查通过；review formatter 实际 diff，保留无关用户修改。 |
| 完成文档检查       | `pnpm run docs check`                                                                                                                                                                 | 不增加 baseline 错误；可用 submodule 环境下应 exit 0。       |

新建的测试路径必须在所属阶段实现后才能运行。最终旧 helper 检查应无命中（`rg` exit 1）：

```sh
rg -n 'writeArchiveStateFailureSafe|attemptedTargets|rollbackErrors' packages/components/src/hooks/use-session-actions.ts
```

测试风格参考 `workspace-writer.test.ts` 的 Promise gate 与状态断言，以及
`doc-meta-subscription.test.ts` 的真实 LoroRepo 双副本 fixture。沿用 fixture 思路，替换其中
依赖真实 timer 的等待，不复制浅层 mock-call-only 断言。
`sqlite-repo-store.test.ts` 已使用真实临时 SQLite，但尚无故障注入证明；
`loro-doc-unload-data-plane-integration.test.ts` 有真实 repository/storage 与可控传输边界。
浏览器 owning suite 的 Vite 加载可参考 `tests/e2e/terminal-theme.spec.ts`，使用实际存储 adapter，
不能以一次模拟的 unavailable error 代替持久化验证。浏览器 adapter 测试不冒充桌面产品 E2E。

## 完成条件与停止条件

- [ ] acceptance matrix 均有 owning test 或实际 runtime 证据，结果注明版本与存储 adapter。
- [ ] 提交前失败零影响；不确定结果有稳定身份；重试和重启不提升旧操作优先级。
- [ ] 生产者与消费者使用同一权威，原始 metadata 与有效投影的界限可审计。
- [ ] 新格式的全体 writer 兼容性有证据；没有仅凭 daemon capability 推断 renderer 兼容。
- [ ] #574 的 target/discovery、并发写入、完整 transition 和恢复均满足 Spec。
- [ ] owning Spec/Note 保持正确状态、双语一致，checks 无新增失败。
- [ ] 主控验收后更新计划状态；GitHub 发布/关闭仅按另行授权执行。

发生以下情况时暂停依赖该条件的步骤，返回具体证据与可继续的独立工作：实际 WASM 语义
不同；storage 无法说明提交/发布边界；必须改动未授权私有系统；旧 writer 仍可破坏新契约；
现有单独 Tab 行为无法表达；持久化或完整 revision 测试失败。不要用 weaker invariant、
blind compensation、无限 UI 等待或一次 toast 绕过这些条件。

本计划不要求现在提交或开新 PR。以后执行若需新分支，使用 `fix/session-lifecycle-commit`；
既有 #658 分支不做本地 rename/push。提交遵循 Conventional Commits，并添加实际运行模型的
`Model:` trailer，不能猜测模型标识。

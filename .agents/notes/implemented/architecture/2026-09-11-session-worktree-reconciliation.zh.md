# 从归档状态而非机器命令收敛会话 worktree

Status: implemented
Translation: current

[English](2026-09-11-session-worktree-reconciliation.md)

## 摘要

归档一个本地项目 Session 会遗留其 worktree 并跳过清理脚本
（[#377](https://github.com/LodyAI/Lody/issues/377)）：daemon 从旧版机器元数据解析项目根，而自
CLI 0.71.0 起该目录只存在于 Machine Flock 中。修复方案用「收敛」取代了归档与删除命令队列：daemon
扫描 Lody 管理的 worktree 目录树，移除任何其根 Session 已归档或已删除的目录——移除前先做一次备份
提交，且不删除分支。整个过程不做任何 ack，因此一次错误的读取不会丢掉一次清理；目录仍然存在本身就
是「还有工作未完成」的唯一证据。未知的 Session 绝不触碰，且清扫会等待完整的工作区元数据。

## 问题

`archiveSessionResources` 只把旧版的 `machineMeta.localProjects` 传给
`resolveWorktreeCleanupTarget`；Flock 的 `localProject` 行是一个默认为空 map 的可选参数，因此这处
遗漏在类型上是正确的、也是静默的。永久删除路径没有暴露该缺口，因为它的命令携带了来自请求方的
`originalRootPath`。社区 PR [#382](https://github.com/LodyAI/Lody/pull/382) 修复了缺失参数，随后又
为该修复暴露出的竞态加入了就绪闸门与 fail-closed 读取：命令可能在其所需数据到达之前就被消费，而
一次瞬时的 Flock 读取失败会 ack 一次根本没有执行的清理。

## 决策

- 归档与删除是状态，而非命令。UI 与 `lody session archive|delete` 只写 `isArchived: true` 或删除
  Session 文档，别无其他。daemon 观察 `isArchived`（释放运行时）与文档删除（删除屏障、operation
  store 清理），然后安排一次 worktree 清扫。
- `WorktreeGarbageCollector`（`apps/cli/src/session/worktree/worktree-gc.ts`）枚举
  `<data>/repos/<repoId>/worktrees/<sessionId>`，并就每个所有者询问工作区。`archived` 与 `deleted`
  （loro-repo 的软删除标记）执行移除；`active` 与 `unknown` 跳过。`unknown` 不构成证据：一个数据
  目录服务于该机器加入的每一个工作区。仓库来源从 `<repoDir>/meta.json`（本地）或 `bare.git` 是否
  存在（GitHub）读取；本地归属通过在项目目录中执行 `git rev-parse --is-inside-work-tree` 确认，
  因为注册的项目可能是一个子目录，其 `.git` 位于仓库根。无法解析仓库的 worktree 会被保留并重试，
  绝不直接删除：对第一版的评审表明，`<root>/.git` 检查会把嵌套项目误判，并会在没有备份提交的情况下
  丢弃未提交文件。
- 移除时 git 报告的分支名，若与记录不同则回写到 `SessionMeta.branchName`；恢复时按该名称重新挂载，
  否则终端中的重命名对工作区而言是不可知的（第二条评审结论）。
- 清扫仅在 `hasCompletedInitialMetaSync()` 为 true 后运行（本地模式始终视为完整），触发时机为归档
  与删除事件以及每十分钟一次。失败按目录退避（30 秒起倍增至 1 小时），且永不终局。
- 归档与删除绝不删除分支。`removeWorktree` 新增 `preserveBranch` 选项，供本地项目移除使用；
  `archiveWorktree` 本就保留分支。
- 清理脚本在移除前运行一次；脚本失败会被记录日志并写入 Session 历史，但不会因此保留目录。
- 旧版的 `cmd/archiveSession`、`cmd/deleteSession` 行以及旧版的 `needToArchiveSessions` /
  `needToDeleteSessions` map 在 daemon 启动时被直接丢弃而不处理。它们对应的 Session 携带相同的
  已归档或已删除状态。
- 共享的命令构造器（`buildMachineArchiveSessionCommand`、`buildMachineDeleteSessionCommand`、
  `session-delete-queue.ts`）已被移除；行类型与解析器保留，以便读取并丢弃旧行。

## 替代方案

- 保留命令队列并修复缺失参数（#382）。否决：它随后必须处理的每一个竞态，都源于消费一条其支撑数据
  另行同步的命令；就绪闸门还会阻塞无关 Session 的运行时释放。
- 让归档命令自描述（像删除那样携带 `originalRootPath`）。作为主修复被否决：旧版布尔队列无法携带
  负载，而 ack 问题依然存在。
- 在元数据同步之后把 `unknown` 所有者视为孤儿。否决：加入多个工作区的机器会删除另一个工作区中仍
  存活的 worktree。

## 证据与限制

`worktree-gc.test.ts` 使用真实 git 仓库（local-shared、嵌套子目录与 bare GitHub 三种布局）与注入
时钟，覆盖带备份提交且保留分支的移除、未知与活跃所有者、元数据完整闸门、运行时释放的延后、仓库
消失（保留）、清理脚本失败、分支重命名、重试退避与清扫合并。
`message-handler-terminal-cleanup.test.ts` 覆盖归档时的运行时释放、删除屏障、旧版记录丢弃，以及
在完全没有项目目录的情况下对本地项目 Session 的端到端归档。UI 与 CLI 套件断言不会写入任何机器命令
或队列。

此处未验证：跨云端重连的真实桌面端运行；loro-repo 的删除标记能否在长期压实后存活。本地项目的移除
对话框仍承诺保留脏 worktree，而归档规则随后会在备份提交之后将其移除；该对话框是后续工作。契约：
[`specs/session-worktree-lifecycle.md`](../../../../specs/session-worktree-lifecycle.md)。

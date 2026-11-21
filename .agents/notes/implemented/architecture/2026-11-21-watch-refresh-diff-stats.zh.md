# 工作区监听刷新发布变化后的累计统计

Status: implemented
Translation: current
PR: [#3064](https://github.com/LodyAI/Lody/pull/3064)

[English](2026-11-21-watch-refresh-diff-stats.md)

## 摘要

在 Lody 轮次之外修改工作区文件时，daemon 只能通过工作区监听得知变化。这条路径会刷新 Code Collab 文件索引，却刻意跳过会话元数据，因此所有读取 catalog 的客户端都会保留旧的 `diffStats.allChange`，直到下一轮刷新。现在监听刷新通过现有的、按归属会话串行的 `WorkspaceGitService.publishDiffStats` 发布比较统计；该发布入口仍然只在累计统计变化时写入。代价是每次监听刷新多一次元数据读取；内容未变化的保存依然不写元数据。

## 决策

`CodeCollabV2Service.refreshWatchedWorkspace` 向共享状态刷新传入 `persistAllChangesDiffStats: true`，与根目录初始化和轮次结束刷新一致。worker 路径和进程内发布路径本来就会携带 `allChangesDiffStats` 与 `memberDiffStats`，因此 Project group Member 的 `diff` 投影也通过同一个发布入口校正。文件索引在 Flock 上仍按内容去重；只有会话元数据是有条件写入的。

`WorkspaceGitService.publishDiffStats` 仍是工作区总计的唯一写入者，并保留 `sameChange` 短路。重新计算后增删行数和文件数都相同的监听刷新会读取元数据，然后直接返回，不调用 `upsertDocMeta`。这样元数据写入只由累计统计的实际变化触发，而不是保存次数或监听节拍。

## 备选方案

曾考虑在调用发布入口前用内存中的镜像比较新的累计统计，但未采用：会话元数据才是权威来源，另一个写入者可能在两次刷新之间修改它，过期镜像会阻止必要的校正。发布入口的元数据读取是有界的，而短路的正是昂贵的持久化写入。

也曾考虑让监听刷新只发布 Flock，等待下一轮刷新。但非轮次编辑可能长期存在，而读取 catalog 而非实时探测的客户端会一直看到旧值。当 catalog 的 `diffStats.allChange` 缺失时，Android 的 All changes 行（`LodyAI/lody-android#21`）不会出现，即使实时探测能看到 Uncommitted 行。

## 影响

不增加定时器、Repo、重试归属或发布队列。监听刷新保留 Flock 文件索引去重和信号行为；新增工作只有这次条件性的元数据发布。清单读取仍然实时且独立于元数据新鲜度。

## 验证

`apps/cli/src/lib/code-collab/code-collab-v2-service.test.ts` 中的 “persists All Changes totals after a workspace watch refresh” 用真实 Git 工作区依次完成初始化、外部编辑和监听刷新，断言会话总计更新，并断言重复发布相同总计时不写元数据。工作区 Git 测试继续覆盖 Project Member 校正和总计未变化的行为。不声明已验证原生界面。

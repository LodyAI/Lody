# 会话 PR 统一读取模型

Status: implemented
Translation: current

[English](2026-11-02-session-pr-read-model.md)

## 摘要

托管版会话中，Info Bar 的 PR 状态（开/关/合并）和 CI 摘要明显慢于侧边栏，二者还可能不一致：侧边栏读会话元数据，Info Bar 用自己从 GitHub 拉取的详情覆盖元数据，而这次拉取可能命中浏览器 HTTP 缓存。"当前 PR"的选取规则也有四份实现，多仓库会话中不同界面可能显示不同的 PR。现在会话元数据是 PR 摘要的唯一来源，统一经由 `@lody/shared` 中一个返回全部关联 PR 视图的纯函数读取。打开会话时的提速依靠机器 PR 协调器已有的"正在查看"高频档。该函数也是日后显式订阅/退订 PR 的唯一合并点。托管 CI 的最坏延迟从客户端 15 秒轮询变为协调器 20 秒高频档，尚未实测。

## 问题与证据

- 只要有实时详情，Info Bar 的状态就取 `derivePrStatusFromDetails(activePrData)`；上下文 chip 和操作可用性判断（`liveCiFailed`）中，实时 check runs 取代了元数据 `s`。这些覆盖都没有参与元数据读取方使用的提供方修订比较。
- `use-github-pr-details.ts` 中由失效触发的重读和挂载时的重读使用默认缓存模式。GitHub 返回 `Cache-Control: private, max-age=60`，重读可能拿到旧响应；它仍被记为新读取，于是这次服务端版本更新不会再触发重读，只有 15 秒一次的兜底轮询会绕过缓存。
- 当前 PR 的选取分散在 `session-list-rows.ts`、`session-tasklist-mapping.ts`、`session-github-state.ts` 和 `archive-view.tsx` 中，只有 `session-github-state.ts` 对多仓库项目按成员仓库过滤。
- 元数据本来就支持多个 PR：`pullRequests` 是协调器独占写入的关联列表，每个仓库的当前 PR 是其最后一项；生命周期寄存器按提供方修订解析状态（见[关联与生命周期的独立归属](../bug-fix/2026-10-25-multi-repository-pr-panel-loss.zh.md)）；CI 和合并状态存于 `pullRequestState[url]`。

## 决定

1. **唯一来源**：PR 状态、CI、合并状态、就绪度的摘要只来自会话元数据。客户端从 GitHub 拉取的数据只用于 PR 标签页和 CI run 列表，既不覆盖摘要，也不参与操作可用性判断。
2. **统一读取**：`packages/shared/src/session-pull-requests.ts` 中的 `resolveSessionPullRequestViews(meta)` 按关联顺序返回全部关联 PR。每个视图含 URL、仓库、编号、解析后的状态、`ci`、`merge`、`readiness`，以及 `current`（是否为所属仓库的最后一个 PR）。`selectPrimarySessionPullRequest(views, repository?)` 沿用原有规则：不给仓库时取旧字段 `reportedAt` 最新的一项，没有则取最后一项；给定仓库名时只看该仓库的 PR；为 `null` 时没有 PR。`resolveSessionPrimaryPullRequest(meta, activeRepository?)` 应用 Info Bar 的仓库规则。侧边栏、任务列表、首页、聊天落地页、归档、项目成员行以及 `getSessionGitHubState` 都使用这些函数。
3. **多仓库一致**：多仓库项目会话的侧边栏行显示其旧版仓库（`project` 的仓库，否则 `repoFullName`）的 PR，即 Info Bar 未选择成员时显示的那个 PR。
4. **订阅接口点**：将来的显式订阅/退订记录会加入 `SessionPullRequestViewSource`，并且只在 `resolveSessionPullRequestViews` 内部与发现的关联列表合并。目前还没有相应字段、存储或订阅行为。
5. **Info Bar 只显示主 PR**；显示多个 PR 留待后续。
6. **CI 状态标记**：标记的结论和弹层标题使用元数据 CI 代码（`s` 通过；`f`/`e` 失败；`p`/`x` 运行中），与侧边栏图标和 Fix CI 的显示条件读取同一个代码。实时 run 只用于列出各项检查；元数据没有 CI 代码时，标记不给结论。
7. **提速**：打开会话会发布查看状态，协调器把该会话放入高频档：到期的目标在约 1 秒防抖后立即查询，之后每 20 秒一次。托管 webhook 几乎即时写入生命周期寄存器。档位和协调器配置都没有改动。
8. **拉取 hook**：每个分片的读取都传 `{ cache: 'reload' }`；hook 不再提供缓存模式参数，所以绕过缓存的读取不会并入一条走缓存的在途请求，也就不会把旧内容记成新读取。
9. **操作后的一致性**：`mergePullRequest` 和 `markReadyForReview` 只在 GitHub 确实合并了 PR、或 ready 转换确实生效时返回 `true`。只有这时，`use-awaited-pr-status.ts` 才让按钮保持进行中，直到元数据状态到达目标，最多 15 秒；切换到别的 PR 时不会继承这个等待。
10. **身份**：视图的仓库和编号取自 URL；已废弃的 `repository`/`number` 字段只在 URL 无法解析时使用。判断当前 PR、选择主 PR 和项目成员行都使用同一个仓库键。

## 备选方案

- **客户端观察存储与元数据按新旧合并（被否决）**：实时拉取结果放入内存存储，按修订与元数据合并，侧边栏也读取它。生命周期有可比较的提供方修订，但 CI 的 `t` 是机器侧上次变化的时间而非提供方修订，新旧只能按观察时间猜测；一致性也只在同一窗口内成立，多 PR 时客户端还得逐个拉取。
- **渲染端把实时观察写回元数据（被否决）**：需要第三个生命周期来源和一次规格变更，增加同步开销，并且与"渲染端不持久化详情读取结果"的规则冲突。

## 影响与限制

- 一致性由结构保证：所有摘要读取同一份同步数据。
- 机器离线时，客户端不再补充 CI 摘要和 Fix CI 操作；按主路径优先原则不在本次范围。
- PR 标签页的状态行仍用实时详情，可能短暂领先于摘要。
- 如果 15 秒超时结束时元数据仍未更新，按钮会恢复可用，而状态点仍显示旧状态。

## 验证

- `packages/shared/tests/session-pull-requests.test.ts`（"session PR views"）：多仓库、旧版 `reportedAt` 排序、生命周期寄存器胜出、缺失 `pullRequestState`、多仓库项目的主 PR。
- `packages/components/tests/session-list-rows.test.ts`：侧边栏行、任务列表和 `getSessionGitHubState` 指向同一个多仓库项目 PR。
- `packages/components/tests/session-info-context-actions.test.tsx`：即使实时 run 失败，chip 仍显示元数据中的 CI 结论；没有元数据时不给结论；PR 标签使用 URL 中的编号。
- `packages/components/tests/session-project-members.test.ts` 和共享视图测试：过时的旧版 `repository`/`number` 字段不会让 PR 归到错误的仓库。
- `packages/components/tests/use-github-pr-details.test.ts`：挂载、失效触发和可合并性轮询的读取都使用 `cache: 'reload'`；合并和 ready 只在确实完成时报告完成。
- `packages/components/tests/use-awaited-pr-status.test.tsx`（假时钟）：状态到达目标或超时后等待结束，且不会跨 PR 延续。
- 未验证：运行中的托管应用、真实 webhook 和轮询延迟，以及归档行（没有渲染测试；它调用的是已测试的选择函数）。

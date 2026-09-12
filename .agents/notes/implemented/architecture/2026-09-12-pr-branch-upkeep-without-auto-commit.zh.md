# 用提示与 UI 信号取代回合结束的自动 commit

Status: implemented
Translation: current

[English](2026-09-12-pr-branch-upkeep-without-auto-commit.md)

## 摘要

关联了 PR 的会话，此前会在回合结束时探测工作区是否有未提交改动，并驱动 Agent
执行额外的、用户没有要求过的 commit 与 push 回合。这种由机器发起的写入让那些
本来在做别的事情的用户感到意外，而且提交的是他们尚未决定保留的工作。现在这项
约束从机器移到了 Create PR 的提示里：提示要求 Agent 在每轮结束时提交并推送，
用户可以在对话中覆盖它。`SessionMeta.workspaceDirty` 与 `workspaceUnpushed` 两个
探测成为可见的兜底信号——回合结束时仍有未发布的工作，Info Bar 就把
`Commit & Push` 作为最高优先级的 action item 显示出来，排在冲突修复、CI 修复和
Merge 之前。提示的约束力弱于强制
钩子，因此残留风险是 Agent 忽略它；而把优先级改成这样的全部意义，正是让这种
情况变得可见，而不是被静默纠正。

## 旧行为的问题

`TurnPostProcessingService.autoCommitAndPushForPR` 会在每个关联 PR 的
GitHub 会话回合结束后运行。它执行 `git status --porcelain`，发现脏区就合成最多
两个额外的 Agent 回合（"commit all changes…"、"push your changes now"），然后
对未推送的提交重复同样的循环。这些是真实的 ACP prompt：它们出现在对话记录里、
消耗 token，并提交用户从未批准过的文件。一个在实验中途结束回合的用户，会发现
实验内容已经被提交并推送到了自己的 PR 上。

这套机制本身也带着不易察觉的重量。它需要一个 `AutoPromptRunner` 在 dispatch
路径之外开启回合、需要贯穿 `finalizeTurn` 的 `onAutoPromptStart`/`onAutoPromptEnd`
回调、需要 `TurnRuntimeState.autoPromptInFlight` 标志、需要一个"finalization 期间
按下停止"的 Agent 取消分支，还需要 edit-and-resend 在改写历史前查询的
`ExecutionSnapshot.hasActiveAutomation` 位。所有这些都只为这一个钩子而存在。

## 替代方案

三个部分，按用户遇到它们的顺序：

1. **提示。** [review-prompts.ts](../../../../packages/shared/src/review-prompts.ts)
   中的 `CREATE_PR_PROMPT` / `CREATE_DRAFT_PR_PROMPT` 现在带有常驻的
   `PR_BRANCH_UPKEEP_INSTRUCTION`：在每轮结束前提交并推送以保持 PR head 最新，
   把它当作默认行为，只有在用户打断或要求别的事情时才跳过，并且要说明而不是
   默默跳过。这些提示放在 `@lody/shared` 里，是因为自动 review 引擎发送同一段
   文本，两条路径因此无法各自漂移。
2. **信号。** `updateSessionDiffStats` 原本就会探测工作区并把
   `SessionMeta.workspaceDirty` 写到 OWNER 会话的 doc meta 上——也就是承载
   `pullRequests` 和轮询器 `pullRequestState` 的同一个 entry。它现在还会写
   `workspaceUnpushed`（见下方的更正），并且是回合结束后唯一的 git 工作。两个探测
   对不确定的结果都保持保守：`git` 的瞬时失败不贡献任何 key，因此持久值会被保留，
   而不是被覆盖成过期的 `false`。两者相互独立——其中一个失败不能压制另一个。
3. **Action item。** `resolveSessionInfoBarGitHubActionIds` 现在按优先级返回所有
   适用的 action，而不是只选一个；工作区为脏时 `commit-and-push` 排在最前。规则
   与完整排序见 [sessions-info-bar.md](../../../docs/sessions-info-bar.md)。

### 由此暴露出的取消路径缺口

`finalizeTurn` 一旦发现回合被取消就会跳过剩余阶段，而探测的唯一调用方
`updateSessionDiffStats` 恰好排在这些提前返回之后。在机器还会自动提交的年代这
无关紧要，因为自动提交路径在取消时同样被跳过。现在则不然：用户在 Agent 改动
文件的中途按下停止，工作区是脏的，而 `workspaceDirty` 仍是上一个干净回合留下的
`false`，于是 Info Bar 什么都不提供，PR 看起来是最新的。而中断恰恰是用户最可能
带着未保存工作离开的时刻。

`TurnPostProcessingService.syncWorkspaceDirty` 现在可以独立发布这个标志（一次
`git status --porcelain`，不涉及 diff stats）。取消会从**两条**互不相干的路径到达
它，而第一次尝试只覆盖了其中一条：

- `finalizeTurn` 的 `stopIfTurnCancelled` 提前返回——停止请求撞上了 finalization；
- `finalizeCancelledTurn`——ACP prompt 执行中按下停止。这才是普通的停止操作，
  而它根本不会调用 `finalizeTurn`，所以只覆盖第一条路径会让主要场景在看起来
  已修复的情况下依然是坏的。

GitHub 能力判定放在 `syncWorkspaceDirty` 内部而不是各调用点：
`finalizeCancelledTurn` 的五个调用方都不携带 `ProjectRef`，而把这条规则复制一份
正是两条取消路径会再次分叉的原因。该 helper 读取当前会话的 `project` 并回退到
owner 的，因此不重复声明绑定的 Side Chat 依然能上报它共享的 checkout。两条路径
都做了保护，探测抛错时取消仍能正常收敛；`workspaceDirtyPublished` 闩则避免
diff stats 之后的取消检查重复执行同一次探测。回退任何一处生产代码的保护都会
让对应测试失败。

### 更正：脏工作区只是信号的一半

本次改动的第一版只用 `workspaceDirty` 作为判据，并且连同使用它的自动提交循环一起
删掉了 `hasUnpushedCommits`。Review 指出这从另一侧重新打开了同一个洞，指出得没错。

`workspaceDirty` 来自 `git status --porcelain`，因此 Agent 一提交它就变成 false。
如果 Agent 提交了但推送失败或被跳过，工作区是干净的、标志是 `false`、bar 不显示
`Commit & Push`——而由于轮询器的 readiness 反映的是**远端** head，它会照常提供
Merge。此时合并会落地一个缺少本地提交的 PR。这正是本次改动想要防止的"用户以为
PR 是最新的"那类失败，只是从另一条路径到达；而且比旧行为更糟：被删掉的自动提交
循环原本有第二个阶段，专门提示 Agent 推送未推送的提交。

`hasUnpushedCommits` 已恢复（`git rev-list @{u}..HEAD --count`），并以
`SessionMeta.workspaceUnpushed` 发布。`getSessionGitHubState` 把两者合成
`hasUnpublishedWork`，关联 PR 时的 `Commit & Push` 以它为判据。没有 PR 时的
`Commit & Push` 仍只看 `workspaceDirty`——没有 PR 就没有会落后的远端分支。

选择本地的 `@{u}..HEAD` 计数而非与 PR head 比较：它不需要 API 调用、不会过期，而且
PR 轮询器会刻意从 `pullRequests` entry 中剥掉 `headCommitSha`，那种比较没有可靠
输入。没有 upstream 的情况返回 `undefined`（不确定，不写入）而不是 `false`，因为
对一个没有跟踪引用的分支报告"没有东西要推"，正是此处要修复的那种虚假的"一切正常"。

`COMMIT_AND_PUSH_PROMPT` 也做了相应放宽：该 action 现在可能在干净工作区上触发，
所以提示改为"没有可提交内容时跳过提交"，并要求推送失败时明确说明而不是静默停止。
两个 locale 条目同步更新了——UI 发送的是本地化字符串，只改常量在生产中是空操作。

## 为什么 Commit & Push 优先于 Merge

这是本次改动中真正承重的部分。没有了自动提交钩子，脏的工作区——或一个未推送的
提交——就意味着 PR head 不是作者最新的工作。旧的排序把 `Resolve Conflicts`、`Fix CI Errors` 和 Merge 排在
`Commit & Push` 之前，而这三者都作用于已推送的 head：合并会落地一个缺少工作区
改动的 PR，"修复 CI"则会针对一个已不能代表该分支的提交进行推理。把
`Commit & Push` 提到最前，等于把唯一能让其余三者变得有意义的操作放在最前面。

折叠规则让这个代价可以承受。只有排在最前的 action 渲染成文字按钮，其余挂在
chevron 下，因此提升一个 action 不会隐藏任何东西。这需要一处修正：
`ContextChipActions` 此前会把 merge action 从 overflow 列表中过滤掉，在 merge 只
可能作为主操作时这是无害的。一旦脏工作区可以排在它前面，这个过滤就会让一个
已验证可合并的 PR 无法从 info bar 合并，因此被降级的 merge 现在渲染为一个执行
当前已选方法的普通菜单项。选择不同的合并方法仍是 split button 的职责，而
merge 重新排到最前时它就会回来。

## 考虑过的替代方案

- **把钩子放在设置后面。** 否决：默认行为本身就是问题所在，而一个 workspace 级
  开关会为一条很少有人启用的路径保留全部自动 prompt 机制。
- **像 PR 状态一样轮询工作区脏状态。** PR reconciler 按计划轮询 GitHub；脏状态是
  本地的，且只会因为回合而改变。回合结束时的检测既精确又免费，而 reconciler
  自己的规则也禁止向调度器添加回合结束钩子。以"有成本但无新信息"否决。
- **把脏状态加进每个 PR 的 `pullRequestState` entry。** 否决：脏是会话 checkout 的
  属性而非 PR 的属性——一个关联了两个 PR 的会话只有一个工作区——而且那些
  entry 有明确的 ≤50B 预算。
- **把"未推送"并入 `workspaceDirty` 合成一个标志。** 否决：两者失效的时刻不同，
  而一个以工作区命名的标志会悄悄改变 `hasChanges`（Create PR 的判据）的含义。
  两个语义诚实的布尔值只多花一个字节的 meta。

## 移除的内容及其后果

`AutoPromptRunner` 及其测试、`markPromptWorkingStarted`、
`onAutoPromptStart` / `onAutoPromptEnd` 回调、`TurnRuntimeState.autoPromptInFlight`
以及 `ExecutionSnapshot.hasActiveAutomation` 都已删除；钩子移除后没有任何代码再
设置或读取它们。`session-edit-and-resend-service.ts` 曾在改写持久历史前的三处
查询 `hasActiveAutomation`。在安全闸里留一个永远为 `false` 的字段，读起来像是
一层其实已经不存在的保护，因此那些判断现在依赖其余条件：`SessionMeta.autoReview`
与处于活动状态的会话 goal。这次收窄是真实且有意为之的——那个位唯一报告过的
automation 就是回合结束后的提交 prompt，而它已经不存在了。

同样移除的还有 finalization 期间要求 Agent 中止的取消分支。finalization 不再运行
Agent prompt，那里已无可取消之物；回合中断本身仍会触发。

## 验证与局限

`apps/cli`：除 `tests/gh-shim-script.test.ts` 外全部通过，那五个测试在基线提交上
以完全相同的方式失败（在 `2acd5117` 的临时 worktree 中验证过）——它 spawn 出的
shim 在此沙盒中退出码为 1，且它的依赖没有一个在本次改动中。被删除的自动提交
测试所承载的子会话覆盖，已改写为针对 `updateSessionDiffStats`——这条路径仍然
负责把子 Tab 的脏标志写到其 owner 的 meta 上，也就是用户实际在看的那个会话。

`@lody/components`：`session-info-action-state.test.ts` 覆盖新的排序，新增的
`session-info-bar-actions.test.tsx` 驱动真实渲染的 bar 来验证折叠行为，包括被
降级的 merge 能从 chevron 菜单调到 `onMerge`。

未验证：Agent 在实践中是否足够遵守这条常驻提示，以致 `Commit & Push` 这个
action item 保持罕见。这是一个本仓库任何测试都无法回答的提示遵从性问题，也正是
UI 信号与提示一同发布、而不是滞后发布的原因。

信号本身的已知局限。两个标志只在回合到达 finalization 或两条取消路径
之一时刷新，且只针对能解析出 GitHub 仓库的会话。因此当回合以抛错结束时它不会
刷新（Agent/模型错误会在 `finalizeTurn` 之前中断），被新 prompt 顶替的 yielded
回合同样不会——不过接替它的回合自身的 finalization 会覆盖这种情况。一个留下了
改动的硬失败回合，在下一个回合收敛前仍可能显示过期的 `false`；这类失败在对话
记录中是可见的，这也是选择保留现状而不是把它扩展到每条错误路径的原因。

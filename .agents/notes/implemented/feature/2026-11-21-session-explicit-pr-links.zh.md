# 会话的显式拉取请求关联

Status: implemented
Translation: current

[English](2026-11-21-session-explicit-pr-links.md)

## 摘要

Lody 过去只按“仓库 + 会话运行时分支”发现会话的 PR。代理在另一分支的临时克隆中执行
`gh pr create`（LodyAI/Lody #3019）时，会话始终不显示这个 PR，Create PR 也一直可用。
现在会话保存显式关联记录：托管的 `gh` shim 把它创建的每个 PR 报告给守护进程，用户可以
在 Info Bar 列表中取消关联。owner 认为手动关联入口很少会用到，因此不提供。协调器仍是 `pullRequests` 的唯一写入者：只有提供方
返回该 PR 后才建立关联。owner 于 2026-11-21 批准此设计。

## 决定

1. **意图记录而非关联。** 每条关联是会话元数据中的独立键
   `prLink:<小写规范 URL>` = `{k: l|u, o: s|u|a, t}`（关联/取消关联；shim、用户、代理；
   毫秒时间）。每个会话最多 32 条。按键独立记录，用户取消关联与机器关联不同 PR 时互不覆盖，
   并通过普通元数据同步到本地、托管、加密和 Roost 工作区。
2. **先经提供方验证再关联。** 尚未关联的 `linked` URL 成为按编号查询的状态目标，可位于任意
   仓库。结果有效时追加到 `pullRequests`，再像发现的 PR 一样执行托管 webhook 关联。PR 不存在、
   仓库被拒或缺少凭据时，每个关联版本只写一次 `prLinkCheck:<key>`，绝不虚构关联。
3. **取消关联的抑制。** `resolveSessionPullRequests` 对所有读取方隐藏已取消关联的 URL，协调器
   无需查询提供方即从列表移除，分支发现也会跳过。之后的 `linked` 记录优先。
4. **当前 PR。** 当前 PR 是最近建立关联的 PR。新关联的 PR 成为当前 PR；显式关联且仍打开的当前 PR
   一直保持，直到另一个 PR 新建立关联。其他打开 PR 收到提供方更新不会改变当前 PR。其余情况沿用既有
   排序（运行时分支上较新的 PR 取代较旧的，终态 PR 让位于打开的 PR）。早期版本把关联 PR 与分支匹配
   同级；两个打开 PR 打平后落到 `updatedAt`，当前 PR 会随最后一次评论、推送或 CI 事件来回切换。
5. **主 PR 位置。** 单项目会话在其项目仓库有 PR 时，主 PR 是该仓库的最后一个 PR；其他仓库的关联
   会列出，但不占据主位置。
6. **shim 报告。** `gh pr create`（REST 或原生）成功后，shim 在 2 秒内把 URL 发送到代理端点
   `/pull-request/report`。守护进程只依据宿主写入的上下文令牌确定会话（子 Tab → 所属会话），
   并写入 `shim` 记录。退出码和 stdout 不变；stderr 只多一行事实说明。
7. **写入者。** 渲染端只写入用户的取消关联记录；守护进程通过 `apps/cli/src/lib/session-pr-links.ts`
   写入 shim 与代理记录，`lody_session_manage` 的 `pr_*` 操作为调用方会话复用其关联、取消关联和列出操作（[操作工具](2026-11-21-mcp-action-tools.zh.md)）。

## 备选方案

- **从代理输出解析 PR 链接，或按作者与时间猜测（owner 否决）。** 两者都会关联无关 PR，且不与提供方无关。
- **由 shim 或渲染端直接写 `pullRequests`（否决）。** 破坏成员与排序的单写入者规则，并会关联未验证的 URL。
- **粘贴链接输入框和会话菜单中的“关联拉取请求”入口（合并前由 owner 移除）。** 很少会用到；
  关联由 shim 报告和代理操作完成。
- **单个映射型元数据字段（否决）。** 映射值整体替换，并发的用户取消关联与 shim 关联可能丢失其一。

## 影响与限制

- 没有托管 shim 的会话（使用原生凭据的本地项目）以及经其他途径创建的 PR（GitHub MCP 工具、
  直接 API、网页）不会自动关联；由代理通过 `lody_session_manage` 的 `pr_link` 操作关联它们（[操作工具](2026-11-21-mcp-action-tools.zh.md)）。
- 无法读取的关联按发现频率重试，并带原因保留在列表中。
- 待确认行在提供方返回 PR 前显示小写 URL。
- 自动交付不变；多个 PR 仍以 `multiple_prs` 停止。

## 验证

- `packages/shared/tests/session-pull-requests.test.ts`（"explicit session PR links"）。
- `apps/cli/src/lib/pr-poller/pr-poll-scheduler.test.ts`（"explicit PR links"）：#3019 场景、新关联的 PR
  成为当前 PR、两个打开 PR 交替更新时当前 PR 不变、终态关联 PR 让位、无需查询的取消关联、重新关联、
  只记录一次的不可读结果，以及一个会话的多个打开 PR 都会轮询。
- `apps/cli/tests/gh-shim-script.test.ts`、`apps/cli/src/lib/git-credential-broker.test.ts`、
  `packages/components/tests/session-pr-links.test.tsx`。
- 未验证：真实守护进程与 GitHub 的往返。

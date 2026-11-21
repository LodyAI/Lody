# 会话的显式拉取请求关联

Status: implemented
Translation: current

[English](2026-11-21-session-explicit-pr-links.md)

## 摘要

Lody 过去只按“仓库 + 会话运行时分支”发现会话的 PR。代理在另一分支的临时克隆中执行
`gh pr create`（LodyAI/Lody #3019）时，会话始终不显示这个 PR，Create PR 也一直可用。
现在会话保存显式关联记录：托管的 `gh` shim 把它创建的每个 PR 报告给守护进程，用户也
可以粘贴 PR 链接来关联，或取消关联。协调器仍是 `pullRequests` 的唯一写入者：只有提供方
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
4. **排序。** 当前 PR 选择中，显式关联的 PR 与运行时分支匹配同级，代理在别处创建的 PR 同样属于本会话。
5. **主 PR 位置。** 单项目会话在其项目仓库有 PR 时，主 PR 是该仓库的最后一个 PR；其他仓库的关联
   会列出，但不占据主位置。
6. **shim 报告。** `gh pr create`（REST 或原生）成功后，shim 在 2 秒内把 URL 发送到代理端点
   `/pull-request/report`。守护进程只依据宿主写入的上下文令牌确定会话（子 Tab → 所属会话），
   并写入 `shim` 记录。退出码和 stdout 不变；stderr 只多一行事实说明。
7. **写入者。** 渲染端直接写入用户自己的记录；守护进程通过 `apps/cli/src/lib/session-pr-links.ts`
   写入 shim 与代理记录，后续的会话级代理工具复用其关联、取消关联和列出操作。

## 备选方案

- **从代理输出解析 PR 链接，或按作者与时间猜测（owner 否决）。** 两者都会关联无关 PR，且不与提供方无关。
- **由 shim 或渲染端直接写 `pullRequests`（否决）。** 破坏成员与排序的单写入者规则，并会关联未验证的 URL。
- **单个映射型元数据字段（否决）。** 映射值整体替换，并发的用户取消关联与 shim 关联可能丢失其一。

## 影响与限制

- 没有托管 shim 的会话（使用原生凭据的本地项目）以及经其他途径创建的 PR（GitHub MCP 工具、
  直接 API、网页）需要手动关联。
- 无法读取的关联按发现频率重试，并带原因保留在列表中。
- 待确认行在提供方返回 PR 前显示小写 URL。
- 自动交付不变；多个 PR 仍以 `multiple_prs` 停止。

## 验证

- `packages/shared/tests/session-pull-requests.test.ts`（"explicit session PR links"）。
- `apps/cli/src/lib/pr-poller/pr-poll-scheduler.test.ts`（"explicit PR links"）：#3019 场景、排序、
  无需查询的取消关联、重新关联、只记录一次的不可读结果，以及一个会话的多个打开 PR 都会轮询。
- `apps/cli/tests/gh-shim-script.test.ts`、`apps/cli/src/lib/git-credential-broker.test.ts`、
  `packages/components/tests/session-pr-links.test.tsx`。
- 未验证：真实守护进程与 GitHub 的往返。

# 统一归档文档与托管工作树保留合同

Status: implemented
Translation: current

[English](2026-10-01-archive-worktree-retention-contract.md)

PR：[#1195](https://github.com/LodyAI/Lody/pull/1195)。

## 摘要

GitHub 指南承诺工作树目录保留至永久删除会话，但已有生命周期合同和 daemon 会在归档后回收目录。会话与工作流指南也夸大了备份保护范围及删除能回收的存储。文档与自动归档设置现在区分对话历史、托管目录、本地分支、非 ignored 改动的备份提交及 ignored 文件。本项不改变清理行为，修正的是公开合同冲突，不代表已确认真实用户数据丢失事件。

## 证据与决定

实现基线 main 为 `93545f01b69cb0c98ddd3f19d46540decd95a007`；归档实现和冲突文案相较初始 `7d502f3d99fdcdbbdd43d032c6d903d4ed497e04` 未变。压缩提示时另核对了 main `c687e45ae6a59e27b5cc7431889c08b3231e9446`，其设置仍使用未说明保留边界的旧提示。已有 PR 搜索找到 [#620](https://github.com/LodyAI/Lody/pull/620) 的生命周期实现和 [#987](https://github.com/LodyAI/Lody/pull/987) 的偏好设置重组，但没有找到有效修复冲突保留文案的 PR。较早的[状态协调决定](../architecture/2026-09-11-session-worktree-reconciliation.zh.md)仍是运行时设计。[#1191](https://github.com/LodyAI/Lody/pull/1191)单独处理偏好设置开关名称，未修复保留合同。

- [工作树](../../../../site-docs/content/docs/zh/%28core-concepts%29/worktrees.mdx)拥有公开的资源保留表、清理时机、备份范围和恢复前提。GitHub、会话与工作流页面链接至这一解释，同时保留各自的使用说明。
- [生命周期 Spec](../../../../specs/session-worktree-lifecycle.zh.md)仍为 draft，现在明确要求手动归档与自动归档使用相同的保留说明。
- 桌面与移动端自动归档设置在用户开启规则前说明边界。规则仅在当前设备启用，但产生的归档状态可以让所属机器回收工作树。
  提示先说对话和分支保留、目录可清理及哪些内容可能丢失；技术备份细节留在工作树文档中，不挤在提示里。
- 配置的 cleanup 脚本先于 `archiveWorktree` 的暂存和提交，因此脚本删除或修改的文件不在备份保证内。备份失败会保留目录等待重试，脚本失败则不会阻止清理。
- 永久删除会话不会删除本地分支和备份提交。手动移除仓库数据会抹除这些恢复资源，不能当作归档的替代操作。

把清理改为保留目录至永久删除，会与现有设计冲突，并改变磁盘占用和恢复行为。本项选择纠正过期承诺并增加可见提示。生命周期 Spec 已记录的本地项目移除对话框“立即清理”文案是独立问题，不在本项范围。

## 验证与限制

所属 [GC 测试套件](../../../../apps/cli/tests/worktree-gc.test.ts)使用临时真实 Git 仓库，并隔离数据和锁目录，覆盖本地与 bare 仓库归档、tracked 修改和删除、untracked 备份、ignored 文件不进入备份、已删除 owner 的 sweep 后分支保留、恢复、备份失败，以及修改文件后失败的 cleanup 脚本。[自动归档套件](../../../../packages/components/tests/auto-archive-pr.test.ts)在 PR 状态变化测试之外，验证实际渲染的中英文提示和两个独立规则开关。

Playwright 另在无账号的本地 fixture 中对比 main 基线与实际设置组件：同一 1280×720 视口、中文、两个规则关闭，没有外部请求，并验证开关独立性及本地持久化。检查后的前后截图上传到发起请求的 Lody 对话，不作为文件清理行为的证据。

最终 GC 套件通过 12 项测试；已有的创建/移除套件通过 41 项，自动归档/设置导航通过 19 项。`pnpm format`、站点内容生成、文档检查、i18n 和导入/平台/公开边界检查均通过。完整 `pnpm check` 在 ACP adapter 编译阶段停止；单独 CLI/components 类型检查也因复用的本地依赖树存在缺失或不匹配依赖而失败，错误未指向本项改动文件。根 lint 停在缺少 Node 类型定义。这些是验证限制，不记作通过，也未修复无关模块。

未归档或删除真实会话。这些 fixture 不验证桌面或移动端跨重连的实际行为、删除标记长期压缩、远程备份持久性，也不保证找回用户脚本移除的文件。Spec 仍待人工审阅。

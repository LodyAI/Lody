# Session PR 变更

Status: draft
Translation: current

[English](session-pr-changes.md)

托管模式下的 Session PR Tab 在 Summary 旁提供 Changes 视图。审阅者可以选
择全部提交、单个提交或连续提交范围，视图使用不可变的提交 SHA 比较并列出
变更文件。文件内容只在展开文件时懒加载，并复用共享 diff viewer 渲染。历
史选择只读；只有完整的当前 Pull Request 差异以后可以接入审阅操作。

该视图不能让 local-only PR 元数据表现得像托管 PR 访问。local-only Session
仍然打开外部 GitHub 页面，不调用托管的详情、比较或变更 API。文件内容缺失、
为二进制或过大时，界面显示明确的不可用状态，同时保留 GitHub 文件链接。

第一版不提供“自上次审阅以来的变更”，因为客户端没有持久化的审阅者检查点。
该选项需要单独的产品决策。

## 证据

- [Session PR 视图](../packages/components/src/components/sessions/pr-tab-view.tsx)
- [GitHub API 客户端](../packages/shared/src/github-api.ts)
- [Diff 范围测试](../packages/components/tests/github-pr-diff.test.ts)

# 嵌套 worktree 文件链接解析

Status: implemented
Translation: current

[English](2026-10-21-nested-worktree-file-links.md)

## 摘要

[Issue #1788](https://github.com/LodyAI/Lody/issues/1788)：agent 在嵌套 worktree 中写出的
相对链接按会话 checkout 解析，导致找不到文件或静默打开 checkout 中的同名文件。现在
Markdown 相对链接会从会话根目录及其内部的同仓库 worktree 收集候选：真实路径唯一时
直接打开，多个时由用户选择。文件树／Diff 的确定路径以及显式绝对、home、父目录相对
链接保持原行为。发现过程不扩展授权。

## 决策

- **来源决定是否发现。** `session-file-open-target.ts` 只标记 agent 写出的相对 href；
  共享解析器在信任边界重复校验同一规则。
- **包含关系。** `git worktree list --porcelain -z` 提供根目录、分支和 HEAD。根目录在
  字面和真实路径上都必须位于会话根目录内，不搜索任意子目录。`relativeBase` 只改变
  查找基准，路径策略仍以会话根目录授权，选中路径在读取时重新授权。
- **返回全部匹配**，按真实路径去重，包含会话根目录。单个候选的权限／I/O 错误使请求
  失败，而不是丢弃该匹配。
- **发现为尽力而为。** 缺少 Git、`.git` 损坏、`safe.directory` 拒绝、超时（5 秒）、
  输出过大（256 KiB）或 worktree 超过 128 个时，退回仅按会话根目录解析（修复前行为），
  不让原本能打开的链接失效。
- **版本差异。** `markdownFileLinks` v1 协商 `file/preview` 上的
  `resolveMarkdownLink: true`；对旧远程 daemon，facade 返回 `unsupported_protocol`，
  渲染端随后按会话根目录照旧打开。同机 Electron 不依赖 daemon 元数据直接解析，保留
  [独立于 daemon 的预览边界](2026-10-16-daemon-independent-local-file-preview.zh.md)。
- **选择器。** 显示绝对路径、worktree 根目录、分支／detached HEAD、commit 和修改时间。
  选择后固定规范路径与行号锚点，不缓存短链接。更新的打开请求或切换会话会丢弃迟到的解析结果。

Effect 评估：预览和 Electron 调用者仍为 Promise 边界；只读 Git 查询复用进程层 Legacy
入口，不宣称完成原生迁移。

## 限制

长期保留嵌套 worktree 的仓库中，大多数相对链接都会弹出选择器，因为 worktree 共享文件。
Markdown 链接右键菜单操作（复制路径／打开／定位）在执行时按同样方式解析，并复用选择器。外部 worktree（#472）
和消息级 cwd 归属不在范围内。

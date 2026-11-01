# 嵌套 worktree 文件链接解析

Status: implemented
Translation: current

[English](2026-10-21-nested-worktree-file-links.md)

## 摘要

[Issue #1788](https://github.com/LodyAI/Lody/issues/1788)：agent 在嵌套 worktree 中写出的
相对链接可能打开 checkout 中的同名文件。文件预览的发现协议从会话根目录及其内部的
同仓库 worktree 收集候选，不扩展授权。会话渲染现在通过文件索引确认相对路径并直接
打开；点击和复制菜单都不调用发现协议。当前行为见[文件界面说明](../../../docs/sessions-file-surfaces.md)。

## 决策

- **来源决定是否发现。** 调用者请求发现时，`resolveSessionFileOpenTarget` 标记 agent
  写出的相对 href；`resolveDirectMarkdownFileOpenTarget` 刻意省略该标记。共享解析器在
  信任边界重复校验发现来源。
- **包含关系。** `git worktree list --porcelain -z` 提供根目录、分支和 HEAD。根目录在
  字面和真实路径上都必须位于会话根目录内，不搜索任意子目录。`relativeBase` 只改变
  查找基准，路径策略仍以会话根目录授权，选中路径在读取时重新授权。
- **返回全部匹配**，按真实路径去重，包含会话根目录。单个候选的权限／I/O 错误使请求
  失败，而不是丢弃该匹配。
- **发现为尽力而为。** 缺少 Git、`.git` 损坏、`safe.directory` 拒绝、超时（5 秒）、
  输出过大（256 KiB）或 worktree 超过 128 个时，退回仅按会话根目录解析（修复前行为），
  不让原本能打开的链接失效。
- **版本差异。** `markdownFileLinks` v1 协商 `file/preview` 上的
  `resolveMarkdownLink: true`；旧远程 daemon 的 facade 返回 `unsupported_protocol`。
  会话打开不经过这层协商，保留[独立于 daemon 的预览边界](2026-10-16-daemon-independent-local-file-preview.zh.md)。
- **结果。** 候选包含绝对路径、worktree 根目录、分支／detached HEAD、commit 和修改时间。
  显式发现调用者必须保留歧义并固定选中的规范路径。会话打开改用索引确认的路径，
  切换会话或出现更新的打开请求后丢弃迟到结果。

Effect 评估：预览和 Electron 调用者仍为 Promise 边界；只读 Git 查询复用进程层 Legacy
入口，不宣称完成原生迁移。

## 限制

长期保留嵌套 worktree 时，发现协议可能为常见文件返回多个候选。会话界面要求精确
索引命中的相对路径或显式绝对路径，避免这层歧义；复制永不解析或重写该路径。
外部 worktree（#472）和消息级 cwd 归属仍不在发现协议的范围内。

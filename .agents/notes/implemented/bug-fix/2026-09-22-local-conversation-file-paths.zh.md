# 保留本机对话文件的真实目标

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/892

[English](2026-09-22-local-conversation-file-paths.md)

## 摘要

对话链接会剥离任意 `worktrees/<uuid>/` 前缀，导致另一个 worktree 中的本机产物被当成
当前工作区内的文件查找，可能显示文件不存在，也可能打开错误的同名文件。本机 Electron
打开本机会话时现在保留这些路径，工具入口也传递原始目标而非缩短后的展示路径。
远程预览授权和工作区外文件只读行为保持不变；尚未在运行中的桌面应用复现用户报告的具体失败。

## 决策与证据

本次补充[本地文件操作修复](2026-09-09-local-file-link-actions.zh.md)。CLI 的本机
`file/resolve-local` 已允许任意普通文件，扩大远程根目录不能修复渲染器传错目标的问题。
`resolveSessionFileOpenTarget` 现在向 Markdown 规范化传递明确的本机路径保留选项。
会话预览与文件操作 Hook 都仅在 Electron 且会话属于当前机器时启用它。已知工作区内
的文件继续使用与索引一致的相对身份；非本机打开仍保留可迁移 worktree 映射。
工具标签可以缩短路径，但点击目标必须完整交给该解析器。

[草案 Spec](../../../../specs/local-file-link-actions.zh.md)记录此行为；不修改 RPC 或保存授权。

## 验证

现有解析器测试覆盖其他 worktree、未解析的工作区元数据、Windows 与父级相对路径、
行号和当前工作区身份。真实文件系统回归测试区分两个工作区的同名文件，并验证目标删除
后仍报不存在，不回退到另一个文件。文件操作测试覆盖通过 Markdown 菜单操作外部 worktree。
82 项聚焦测试、`pnpm check`（含完整 CI 测试）、`pnpm format` 和
`pnpm run docs check` 均通过。尚未替换或手动验证已安装的桌面应用。

# 发布本地 worktree 身份前规范化项目根路径

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/1029

[English](2026-09-26-local-project-symlink-worktree-path.md)

## 摘要

旧版本登记的本地项目可能保留符号链接路径，而守护进程按链接指向的真实路径创建
worktree。界面却哈希已发布的链接路径，导致“复制路径”和“在 VS Code 中打开”
指向不存在的 worktree 目录。项目所在的守护进程现在会在写入项目时规范化根路径，
并在工作区启动时修复旧记录，同时保留项目 ID。目标暂时不可用时仍保留原路径。

## 决策

项目记录是本地 worktree 路径推导的共享来源。CLI 创建 worktree 前已经规范化
项目根路径，因此也必须由同一台机器把规范化结果发布到 Machine Flock。
`upsertMachineLocalProject` 规范化有效目录路径，包括保留旧项目 ID 和历史记录
的写入。`LodyFleet` 在工作区启动后修复现有记录，覆盖早于路径规范化规则的
项目。修复过程与历史提供者共用机器目录写入锁，避免记录重写时丢失并发更新的历史。
界面继续使用不依赖 Node 文件系统的路径构造器，无需新增原生依赖。

更新记录的 `rootPath` 时保留 `id`、名称、创建时间和历史，避免旧 Session 的
项目引用失效。如果目标不可用，守护进程保留原路径，不记录未经验证的新目标。
如果符号链接在 worktree 创建后改指向别处，这是另一个持久身份问题：单凭项目
记录无法知道已有 Session 当时使用了哪个目标。

## 证据与验证

报告中的符号链接与实际 worktree 指向同一仓库，但哈希链接路径和真实路径得到
不同的本地仓库 ID。修复与后续写入的回归测试使用真实的临时符号链接，并检查
发布到 Machine Flock 的记录。参见
[`local-project-meta.test.ts`](../../../../apps/cli/src/lib/local-project-meta.test.ts)。
本地项目元数据与历史记录的 81 项聚焦测试均通过。嵌套 checkout 缺少 ACP 子模块
和大多数 `node_modules`，因此根目录的 `pnpm check`、`pnpm format` 与
`pnpm run docs check` 无法在此完成；已用 Oxfmt 单独格式化修改的文件。
尚未替换已安装的桌面应用或手动点击验证。

本决策补充[主机路径推导修复](2026-09-14-lody-data-dir-path-root.zh.md)。

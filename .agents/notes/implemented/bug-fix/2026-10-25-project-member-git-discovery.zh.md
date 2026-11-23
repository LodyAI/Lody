# 文件系统边界处的非 Git 成员探测

Status: implemented
Translation: current

[English](2026-10-25-project-member-git-discovery.md)

## 摘要

Project 成员探测识别了 Git 遍历完父目录的报错，却拒绝了文件系统边界变体，导致
[PR #1877 CI](https://github.com/LodyAI/Lody/actions/runs/40192661157) 的五项 CLI 测试失败，
涉及本地副本解析和非 Git 成员物化。现仅在退出码为 128 时接受这两种探测报错，
其他命令失败仍向上传播。

## 决策与证据

[非 Git 成员契约](../../proposed/architecture/2026-10-16-multi-repo-projects.md#revision-non-git-members-and-multiple-roots)
要求已存在的普通目录可成功返回非 Git 探测结果。Git 在挂载边界停止查找时返回
`not a git repository (or any parent up to mount point ...)`，原适配器只识别
`not a git repository (or any of the parent directories)`。

保留原生 WorktreeGit 所有者及类型化失败边界，仅识别这两种探测文本；不把所有
退出码 128 当作非 Git，也不改变 Git 的跨文件系统发现策略。权限失败和明确损坏的
`.git` 路径仍是错误。进程生命周期和迁移边界不变。

## 验证

原有 workspace 套件注入两种诊断并检查探测结果，同时验证其他退出码、权限失败和
损坏 `.git` 路径继续抛错。文件系统边界用例在原代码上失败，现有真实 Git 的
workspace 与 Session 测试覆盖上层消费者。

在独立克隆中按冻结 lockfile 安装依赖并构建 ACP 适配器后，两个原先失败的套件与
Nowledge 套件共 66 项测试全部通过。全仓类型、lint、格式化、i18n 和边界检查通过。
完整 `pnpm check` 中 4,655 项 CLI 测试与 6,071 项组件测试通过，但一项无关 SSH
夹具被宿主会话的 Git shim 拦截（`context_unreadable`），导致命令失败。该夹具在
原生 Git PATH 且移除继承的 GIT_EXEC_PATH/GIT_SSH 覆盖后通过。
编辑工作树的文档检查保留 84 项基线错误，无新增。

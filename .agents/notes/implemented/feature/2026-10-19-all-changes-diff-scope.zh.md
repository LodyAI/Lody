# 区分分支累计修改与仅未提交修改的 All Changes diff

Status: implemented
Translation: current

[English](2026-10-19-all-changes-diff-scope.md)

## 摘要

All Changes 原先比较 `merge-base(base, HEAD)` 与磁盘内容，已提交的分支修改因此仍留在 diff 中，界面也从不说明基准。工作区 diff 现在接受 `branch`（保持原默认）和 `uncommitted`（`HEAD` 与磁盘，含已暂存、未暂存和未忽略的未跟踪文件）两种范围，显示解析出的基准，默认仍为 `branch`。Changes 侧栏文件列表保持分支累计。

## 决策

- 范围同时随批量请求和延迟单文件请求传递；延迟读取保持实时语义，可能看到更新的 `HEAD`，未提交模式绝不回退到 turn 证据快照。
- 非 Git 与未出生仓库返回明确的 `not_a_git_worktree` / `no_commits`；此前静默使用 `HEAD` 会只返回未跟踪文件。
- `codeCollabAllChangesScope` 协议能力版本 1 控制入口；旧 daemon 继续收到不带该字段的 branch 请求。
- 未提交模式渲染批量响应自己的文件集合，并对集合外的焦点文件给出明确提示。Changes 列表保持分支累计，因为其他界面消费这份已发布状态。

## 验证

真实 Git 仓库的 service 测试覆盖分支/已提交/已暂存/未暂存/未跟踪/删除、commit 后清空、非 Git 与无 HEAD、延迟加载范围以及 `not_changed`。完整 CLI 测试、相关组件测试与各包类型检查通过；Storybook 状态已在浏览器中实际操作。本次不改变 Changes 侧栏列表；超出预算的文件继续延迟加载。

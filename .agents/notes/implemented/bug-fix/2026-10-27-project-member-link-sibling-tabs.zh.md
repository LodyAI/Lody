# 为同级标签页保留非 Git 成员链接

Status: implemented
Translation: current

[English](2026-10-27-project-member-link-sibling-tabs.md)

## 摘要

非 Git 的 Project 成员以 ACP 额外目录提供给 Agent；Provider 不支持时，则通过主目录中的
链接访问。子标签页共享主目录和 Project 快照，并且每次启动都会重新决定方式：支持额外目录的
标签页会删除链接，导致仍在运行、但 Provider 不支持额外目录的同级标签页在对话中途失去该
文件夹，快照也随最后启动的标签页来回切换。现在保留正确的链接；支持额外目录的 Provider
仍然收到绝对路径，只要链接存在，快照就记录为 `link`。

## 决策与依据

`resolveAdditionalDirectories`（session-manager）和 Project 准备流程都会调用
`reconcileProjectMemberLink`，它在 `additional` 为 true 时会删除正确的链接。现在改为保留，
并返回成员是否可通过链接访问；调用方据此记录 `link` 或 `additional`。指向其他目标的链接
仍会被删除，支持额外目录的 Provider 也不会新建链接。

两条路径指向同一个文件夹。文件根在两种方式下都只登记该成员一次，主目录不是 Git 检出，
归档本来就只删除已知链接。在链接之外仍传入额外目录，也能让沙箱型 Provider 允许写入真实
路径。考虑过：链接存在后不再传额外目录（Agent 只看到一条路径），但沙箱按真实路径判断时
可能拒绝写入，因此未采用。

## 验证

`workspace-git-service.test.ts` 覆盖：父标签页的链接在后续以额外目录启动后仍保留、错误
链接被删除、且不会新建链接；改回旧的删除行为时该测试失败。会话启动、worktree 和
session-manager 测试通过。CLI 类型检查只报告未构建的 `acp-extension-claude` 产物。
未用两个真实 Provider 做端到端验证。

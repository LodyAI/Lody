# 将本地项目删除过渡态排除在访问错误之外

Status: implemented
Translation: current

[English](2026-09-20-local-project-removal-race.md)

## 摘要

删除本地项目时，持久化的 Machine Flock 命令一写入，项目行就会被乐观隐藏。
但聊天 landing 可能仍保留该项目的选中状态，因此普通可用性检查会在删除结果通知
显示成功之前短暂报告“无法访问本地项目”。现在 landing 会在导航回普通 `/chat` 时
清除旧的 URL 选中项目，并将 pending 删除和结果通知处理窗口视为预期的删除过渡态。
真正的访问权限或元数据错误仍按原逻辑提示。

## 证据与决策

Machine Flock overlay 会按设计从 `MachineViewMeta.localProjects` 中移除带有 pending
删除命令的项目，而 `usePendingLocalProjectRemovals` 通过另一份生命周期视图保留该命令。
侧边栏导航到普通 `/chat` 后，chat landing 的选中状态可能仍存在；于是
`getChatLandingLocalProjectAvailability` 会在乐观元数据行消失后继续检查旧项目。把这次
缺失误判为授权失败，就会和删除结果 toast 发生竞态。

可用性检查仍是实际授权和元数据失败的唯一来源。landing 会先清除旧的本地项目 URL 选
择，避免乐观 overlay 验证旧状态；随后额外检查已有的 pending 删除映射，以及由删除结果
通知 hook 管理的完成抑制集合。后者覆盖观察到 completed 命令到删除命令行之间的间隔，
确保删除操作只出现成功或警告结果。completed 行消失后抑制状态会清理；确认失败时保留
命令行，沿用现有重试路径。

## 验证

`chat-landing-derived.test.ts` 覆盖删除期间抑制提示、真实不可用项目仍需提示，以及
pending/available 状态不应提示。定向测试通过，共 77 项。已对修改的组件运行类型检查
和格式化；提交前仍需运行仓库级文档检查和完整检查命令。

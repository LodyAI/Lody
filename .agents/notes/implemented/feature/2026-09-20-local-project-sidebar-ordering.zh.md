# 本地项目 Sidebar 排序

Status: implemented
Translation: current

[English](2026-09-20-local-project-sidebar-ordering.md)

## 摘要

桌面端 sidebar 的 GitHub 仓库分组原本可以调整顺序，但本地项目文件夹只能保持创建顺序。
现在本地项目在各自的设备分区内使用同样的拖拽手柄，并按工作区持久化带设备标识的顺序。
保存过的条目在项目暂时离开目录时仍会保留，因此设备离线或重连不会重置用户布局；移动端
仍不提供拖拽。

## 决策与证据

排序偏好属于 sidebar 状态，而不是项目元数据：它只改变单个用户看到的排列，不应修改
共享项目目录。因此 `localProjectOrderAtom` 沿用仓库排序按工作区存储的模式，但保存
`${machineId}:${localProjectId}`，因为本地 project id 只在所属设备内唯一。

每个可见设备分区各自持有一个 dnd-kit context。这样拖动始终留在设备边界内，并整体移动
项目分组及其展开的 Sessions。激活区域是明确的 hover 手柄，所以点击项目行仍负责导航，
Session 行也继续使用现有的 HTML5 mention 拖拽。

目录投影会先应用保存的排名，再对未见过的项目沿用原有的创建时间/名称确定性排序。
发现项目时只追加 key，不删除当前缺席的 key，因此短暂的可见性或连接变化不会抹掉偏好。

## 验证与限制

- `sidebar-local-project-order.test.ts` 验证持久化 atom 的工作区隔离，以及未解析工作区时
  拒绝写入，并覆盖移动时保留暂时隐藏及其他设备条目。现有的本地项目行渲染测试和
  worktree sidebar 测试也通过。
- Components 类型检查停在已有的 Electron 登录/更新与 session activity 错误，
  变更文件没有产生诊断。文档检查同样只命中仓库已有的 submodule 断链。
- 排序仅在桌面端提供，也不能跨设备分区。

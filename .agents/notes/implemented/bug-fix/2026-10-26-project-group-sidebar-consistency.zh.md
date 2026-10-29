# 多成员项目遵循单个项目的 sidebar 规则

Status: implemented
Translation: current

[English](2026-10-26-project-group-sidebar-consistency.md)

## 摘要

一份 Windows 上的反馈显示：GitHub 侧的多成员项目在归档全部对话后仍留在 sidebar，
菜单里没有删除；在设置中删除后，恢复任一对话又会重新出现，且收起按钮无效。原因是
项目组按定义而不是按对话列出，没有移除操作，已删除项目组的标题把 `collapsed`
写死为 `false`。现在每个项目组与相邻项目保持一致：和 GitHub 仓库放在一起时只在有对话
时显示；在机器下像文件夹一样一直显示；创建者可以在菜单中移除；已删除项目组的标题可以收起。

## 决策与依据

用户希望多成员项目尽量与单个项目一致。`buildGroups` 中的仓库分组只在有对话时存在，
机器下的文件夹则一直显示并提供「移除项目」。

- `placeProjectGroups` 去掉没有对话的 GitHub 侧项目组。已删除项目被恢复的对话仍以快照
  名称显示，与断开连接的仓库一致；这个标题现在使用真实的收起状态。
- 标题菜单为创建者（`canManageWorkspaceProject`）增加「移除项目」，复用已有的删除请求和
  确认对话框。删除仍保留其对话。
- 未改变：绑定机器的项目组空闲时仍显示；新建的仅 GitHub 项目在第一个对话后才出现在
  sidebar，与新连接的仓库一致，Composer 选择器中则立即可选。

## 验证

`sidebar-navigation-model.test.ts` 通过真实的放置和列表模型验证：空闲的 GitHub 侧项目组
被隐藏、机器下的项目组保留、已收起的删除项目组隐藏其行；撤销任一修复都会失败。
`project-group-launch.test.ts` 按新规则更新。Playwright story 检查确认创建者能看到
「移除项目」而队友看不到。未在 Windows 上实际复现。

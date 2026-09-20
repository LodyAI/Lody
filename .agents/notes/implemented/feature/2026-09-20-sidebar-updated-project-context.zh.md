# Updated 侧栏行显示所属 project

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/838

[English](2026-09-20-sidebar-updated-project-context.md)

## 摘要

Updated 组织模式把所有 project 混成一条按最近更新排序的列表，只显示标题就看不出会话属于哪里。顶层行现在多一行，用 Project 分组头已经在用的识别标记（文件夹、GitHub owner 头像或对话图标）加上项目名或分区名。嵌套的 opened Session 仍只显示标题，好让 opened-by 树干继续按 30px 行高对齐。Workspace 模式的置顶区不加这行，因为那些行旁边仍是各自的 project 分组。

## 问题与决定

Project 组织模式把会话放在本地文件夹、GitHub 仓库或 Chats 标题下，分组头已经回答「属于哪个 project」。Updated 模式故意丢掉这层结构。混排之后只剩标题，刚更新的另一个文件夹里的会话和当前项目的会话无法区分。

`SidebarUpdatedSessionList` 接受 `showProjectContext`。`LoroSidebar` 在 `organizeMode === 'updated'` 时对置顶区和 Updated 列表打开它。第二行优先用 `subtitle`（本地文件夹名、GitHub `owner/repo`），Chat 回退到 `sectionLabel`。嵌套子行（`openedByTree.kind === 'child'`）不加这行：它们通过缩进继承父行的 project。

标题行仍占 20px 内容高，好让展开控件、连接线和尾槽留在那一行。标题和 project 之间留 4px，两行行用 `py-1.5`，避免贴着高亮边。两行父行下面的第一个子行把向上的树干从 `-top-2` 拉到 `-top-7`，补上 subtitle 多出来的高度；后续兄弟仍用单行树干。

曾在「最近更新」下嵌过「显示项目」勾选项，后来拿掉了：筛选更吵，默认行为却不变——只要进了 Updated 就显示 project。

## 备选与取舍

把 project 身份只放在悬停卡片里已经成立，但不够：Updated 是扫读列表，而且悬停只在桌面。Workspace 模式的置顶区显示这行也能给混排行贴标签，但那些行仍在同一侧栏的 project 分组之上，这次范围只覆盖 Updated。给嵌套子行也加第二行会把树干画成一段一段的虚线，因为树干长度按 30px 行高编码。

## 验证

`sidebar-updated-project-context.test.tsx` 覆盖本地 / GitHub / Chat 标记、Workspace 默认不加行、以及嵌套子行不加行。`loro-sidebar-pinned-section.test.tsx` 确认 Updated 模式的置顶显示这行、Workspace 模式的置顶不显示。现有 opened-by 套件继续覆盖展开控件和连接线。

相关：[sidebar session tree](../../../docs/components-sidebar-session-tree.md)。

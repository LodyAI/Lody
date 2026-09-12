# 侧边栏搜索入口

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/598

[English](2026-09-11-sidebar-search.md)

## 摘要

命令面板需要一个可见的侧边栏入口，以服务不使用 Cmd K 的用户。搜索现在紧跟在 New Chat
下方出现，并通过共享状态打开既有的命令面板。复用导航行与其翻译，使该入口与侧边栏保持
一致；搜索行为仍由命令面板拥有。

## 决策与证据

[侧边栏](../../../../packages/components/src/components/loro-sidebar.tsx)把既有的
命令面板状态置为打开，因此重复触发是幂等的。它没有新增路由，也没有合成键盘事件。
[Spec](../../../../specs/sidebar-search.md)记录了所要求的位置与行为。验证结果与任何
环境限制记录在 PR 中。

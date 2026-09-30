# 侧边栏搜索

Status: draft
Translation: current

[English](sidebar-search.md)

侧边栏在 New Chat 下方提供本地化的 Search 行。点击 Search 会打开与 Cmd K
（其他平台为 Ctrl K）相同的命令面板，并提供相同的搜索结果和操作。它不会离开当前对话，
也不会创建独立的搜索界面。

按 Escape 会关闭命令面板。输入法编辑器正在组合文字时，Escape 仍可先取消组合输入，
再关闭面板。

## 实现证据

- [侧边栏](../packages/components/src/components/loro-sidebar.tsx)
- [共享面板状态](../packages/components/src/lib/commands/palette-state.ts)
- [面板键盘处理](../packages/components/src/components/commands/command-palette-view.tsx)

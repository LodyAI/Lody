# Zen 布局

Status: draft
Translation: current

[English](zen-layout.md)

桌面端用 `Cmd+.`（其他系统为 `Ctrl+.`）切换侧栏可见性。任一侧栏可见时，
进入 Zen 并隐藏两侧，不改变已保存的展开偏好。再次切换恢复这些偏好，包括
原先只展开一侧的布局。

所有可用侧栏都已关闭时，切换立即展开它们，并退出 Zen。这次显式展开更新
正常的展开偏好；Zen 已开启但当前页面没有可恢复的已展开侧栏时也采用此行为。
没有右侧栏的页面只展开导航栏。右侧栏的标签及选择保持不变，空面板显示启动入口。

显式打开任一侧栏都会退出 Zen 并展开该侧栏。右侧栏隐藏时按实际可见性暂停后台
工作。Zen 是窗口内的临时状态；快捷键仅限桌面端，并让位于编辑器按键作用域。

## 依据

- [状态与切换](../packages/components/src/atoms/layout-state.ts)
- [会话面板所有者](../packages/components/src/components/sessions/session-detail.tsx)
- [回归测试](../packages/components/tests/layout-state.test.ts)
- [决策记录](../.agents/notes/implemented/bug-fix/2026-09-20-zen-collapsed-sidebars.zh.md)

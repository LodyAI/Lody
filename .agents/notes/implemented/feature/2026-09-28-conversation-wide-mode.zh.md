# 对话全宽显示模式

Status: implemented
Translation: current

[English](2026-09-28-conversation-wide-mode.md)

PR: [#1080](https://github.com/LodyAI/Lody/pull/1080)

## 摘要

会话对话栏此前被硬性限制在约 48rem，桌面大窗口下两侧大量留白。新增"全宽显示"开关(设备级持久化)可去掉该上限,让对话栏铺满面板、只保留共享的两侧 gutter。两个入口写同一个 atom:Settings > Appearance 的开关,以及会话 `⋯` 菜单顶部 identity 区块后、动作区之前的一行尾部 `Switch`。不改 SessionMeta —— 视图偏好不是会话状态,不应跨设备、跨成员同步。

## 决策与证据

- `conversationWideModeAtom`(`atomWithStorage`,`lody-conversation-wide-mode`,默认 `false`)放在 `atoms/settings.ts`,与其它会话外观偏好并列。
- `ConversationColumn` 是限宽的唯一落点:它读 atom,在 `lib/conversation-layout.ts` 的 `CONVERSATION_CONTENT_WIDTH_CLASS` 与不限宽的 `CONVERSATION_CONTENT_WIDTH_WIDE_CLASS` 之间切换,消息流、context strip、composer、info bar、pin、permission 等所有区域一起变化。`mx-auto` 保留,若将来某个后代恢复限宽仍能居中。
- Settings 有带标签的开关(`settings.conversationWideMode.*`);`⋯` 菜单里是一行带尾部 `@lody/ui` `Switch` 的 `Menu.Item`(`sessions.fullWidth`),`closeOnClick={false}`,切换时菜单不收起。设备级 `localStorage` 是正确的持久化层级:与 `SessionMeta` 不同,它不会把队友或另一台设备的布局一起改。
- `tests/conversation-wide-mode.test.tsx` 用真实 atom→class 断言钉住 `ConversationColumn` 的行为契约;Storybook 增加 `wide` arg 与 `DesktopReadingReviewWide` story,两套排版在同一 harness 里对照。
- 验证:`@lody/components` `pnpm typecheck` 通过,conversation-wide-mode + appearance-settings vitest 12/12 通过,Playwright 截图对比限宽列、全宽列与菜单内 Switch 均确认。

## 修正：为消息锚点留出空间（2026-10-02）

PR: [#1205](https://github.com/LodyAI/Lody/pull/1205)

原有桌面端 18px 边距会让消息锚点栏覆盖全宽模式的正文：锚点栏包含放大后的活动刻度共占 50px。
`ConversationColumn` 现在从 640px 断点起保留左右各 64px 的边距，消息、输入框及其它共享对话列的区域保持对齐。
低于该断点仍使用 14px 边距，限宽模式不变。这样既保留全宽模式，也为锚点提供了足够的空间。

验证：组件包全部 4,641 个测试通过。Playwright 实测 1440px 视口的两侧边距均为 64px，
悬停时也能避开 50px 锚点栏；430px 视口的边距为 14px。类型检查、lint、格式、文档及边界检查通过。
根目录 `pnpm check` 在无关的 CLI `workspace-git-service.test.ts` GitHub remote 元数据补全断言处失败，
该测试单独重跑也失败。

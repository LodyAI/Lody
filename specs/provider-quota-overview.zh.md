# Provider 额度概览与重置预测

Status: draft
Translation: current

[English](provider-quota-overview.md)

浏览已配置 Provider 的人需要识别 Provider，并判断订阅剩余额度。第三方重置概率属于另一类信息：65% 的重置概率不应在 5h、7d 额度旁边读起来像另一个剩余额度百分比。

## 行结构

Provider 行展示身份和模型／使用情况元信息、只读剩余额度、符合条件时显示的平面「重置预测」入口，以及常驻且标明 Provider 名称的管理菜单。所有已报告窗口保留名称和百分比。窄面板将额度放到身份下方；额外窗口自动换行，不通过数量标记或中间详情 popover 隐藏数据。

额度组明确将百分比标注为剩余额度。刷新模型／模式和删除归入 Provider 菜单；删除保留确认步骤。点击身份区域仍能进入 Provider 配置。悬停不得移动或遮挡控件，也不为隐藏操作预留空槽位。

## 直接预测入口

「重置预测」一步打开现有预测弹窗。不设置「额度详情」按钮，也不通过中间弹层重复行内可见信息。入口文字不携带预测概率或缓存百分比。预测弹窗沿用现有语义说明第三方来源、重置概率或已公布的计划。

符合条件的第一方 Codex Provider 即使没有报告额度或当前没有有效预测，也保留入口。用量未知时不伪造额度。列出 Provider 不请求预测，点击入口后才重新验证共享 store。关闭弹窗后，键盘焦点返回直接入口。Composer 的预测行为保持不变。

## 证据

- [Provider 行](../packages/components/src/components/settings/provider-row.tsx)
- [只读额度与直接预测入口](../packages/components/src/components/settings/provider-usage-summary.tsx)
- [浏览器行为](../packages/components/tests/e2e/desktop-settings-layout.spec.ts)
- [Provider 测试](../packages/components/tests/provider-row-reauthentication.test.tsx)
- [决策](../.agents/notes/implemented/bug-fix/2026-10-10-codex-reset-provider-actions.zh.md)

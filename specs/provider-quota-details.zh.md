# Provider 额度详情

Status: draft
Translation: current

[English](provider-quota-details.md)

浏览已配置 Provider 的人需要识别 Provider，并判断订阅剩余额度。第三方重置概率属于另一类信息：65% 的重置概率不应在 5h、7d 额度旁边读起来像另一个剩余额度百分比。

## 概览与操作

Provider 行展示身份和模型／使用情况元信息、只读的剩余额度摘要、明确标为「额度详情」的按钮，以及常驻的 Provider 管理菜单。摘要最多展示两个已报告窗口和额外窗口数量；详情保留全部窗口及其 Provider 提供的名称。摘要在默认与悬停状态均可见。面板较窄时，额度放到身份区域下方，不覆盖身份内容。悬停不得移动控件、显示遮挡控件的覆盖层，或为隐藏操作预留空槽位。

摘要明确将百分比标注为剩余额度。刷新模型／模式和删除归入该具名 Provider 的菜单；删除保留确认步骤。点击身份区域仍能进入 Provider 配置。

## 额度与预测详情

点击「额度详情」按钮打开该 Provider 配置的详情，显示它报告的各窗口剩余百分比。符合条件的第一方 Codex Provider 即使尚未报告用量，也保留额度详情入口，并说明没有用量数据。

第三方重置预测入口位于额度详情内，与已报告额度分隔，并注明来源 codex-resets.com。概览和入口按钮均不携带预测概率。预测弹窗沿用现有语义解释重置概率或已公布的计划。

列出 Provider 和打开额度详情均不请求预测数据。只有点击预测入口才重新验证共享预测 store。关闭额度 popover 不得导致预测弹窗随之卸载。Composer 的用量行为保持不变。

## 证据

- [Provider 行](../packages/components/src/components/settings/provider-row.tsx)
- [额度摘要与详情](../packages/components/src/components/settings/provider-usage-details.tsx)
- [浏览器行为](../packages/components/tests/e2e/desktop-settings-layout.spec.ts)
- [Provider 测试](../packages/components/tests/provider-row-reauthentication.test.tsx)
- [决策](../.agents/notes/implemented/bug-fix/2026-10-10-codex-reset-provider-actions.zh.md)

# AI 用量与 Provider 配额：保留区块设计，调整设置页归属

Status: proposed
Type: feature
Translation: current

[English](2026-10-25-ai-usage-dashboard.md)

## 摘要

Lody 同时需要当前 Provider 额度与历史消耗报表，并保留用户原有的记录行和图表设计。用户现在要求将配置和账号额度放在 Agents 内，通过图标按钮切换，共用同一批记录行。AI Usage 回到消耗分析。[UX 层级决策](2026-10-26-agent-usage-ux-research.zh.md)维护当前归属。配额历史与采样已移除；准确账号归因和 #361 等待数据仍未实现。本文保留区块参考与后续数据契约，视觉结果仍处于提案评审状态。

## 实现状态（2026-10-27）

- `AgentsViewToggle` 通过重叠的淡入淡出和模糊图标切换配置与额度。配置按机器展示，额度跨可见机器按 Provider 分组，两者共用 `ProviderRow`、配置操作与行级刷新。
- `ProviderQuotaWindows` 在 Agents 和参考视图间共用完整窗口、重置时间和钱包呈现。全部上报窗口直接可见，不提供下拉、历史、余量分布或配置跳转。缺少账号身份时不合并配置。
- Agents 配置保留机器标签；额度改为 Provider 区块，记录行标明机器，编辑指向所属机器。切回配置保留选中机器。
- AI Usage 保留 `usageAnalytics` 门控、工作区标题、周期、总量、活动、每日详情、分享和模型/成员明细。按模型家族推导的 Provider/机器混合表仅作参考，因为来源归因尚未得到验证。
- **未接入：**#361 延迟轮次记录。移除配额历史、采样方案和历史样例，不增加调度器或等待权威。
- 默认故事保留剩余区块参考。Composed 与 AgentsPage 预览视图切换，AgentsQuota 与 LocalQuota 初始选中额度，Consumption 预览 AI Usage。验证和限制记录在[层级说明](2026-10-26-agent-usage-ux-research.zh.md#验证与限制)中。

## 场景

1. **还能不能继续？** 哪些 Provider 账号接近上限、窗口什么时候重置、账号属于哪台机器？
2. **钱花在哪？** 哪个 Provider、机器、模型产生了 token 和估算成本？
3. **什么被挡住了？** 哪些会话因为结构化配额限制失败、已经等了多久、什么时候重试？

这些问题定义不同的信息范围。完整原稿保留为参考故事，当前归属由关联的层级说明维护。

## 提案

下列四个剩余区块保留为视觉与数据参考，生产归属由关联的层级说明维护：

| 区块            | 内容                                                                   |
| --------------- | ---------------------------------------------------------------------- |
| 实时配额        | 每个 Provider 账号一行：身份、机器、5h/7d 窗口、重置时间、余额或未上报 |
| 用量            | Tokens、成本、轮次、配额中断；一条按 Provider 堆叠的趋势               |
| Provider 与机器 | 每个 Provider/机器 一行：Tokens、成本、占比、配额                      |
| 等待恢复        | #361 的会话，已等待时间、下一次动作、取消、打开会话                    |

配额、归因和等待原先按单张分隔行卡片设计。当前层级复用这些视觉资产，移除配额历史，完整等待操作仍属于后续会话功能。

### 等待行为

- 显示**已等待时间和下一次重试**，不画进度条。
- **取消**是真正的本地控制：先停止自动重试，再通知 daemon；页面不等服务端确认。
- 已经渲染的结果保留，等待不会清空列表。
- deadline 已过但所属机器离线时显示 `waiting_for_machine`。
- `needs_attention` 对应“提交后 daemon 退出”的场景：本地没有输出不等于 Provider 没做事，因此不自动重放。
- 页面不拥有 timer 或调度权。它读取 durable 记录，并请求 daemon 取消。

## 设计约束

这些是 owner 的 taste review 定下的：

- 沿用已有设置页并保留原有区块布局；用户要求的层级预览在 Agents 内切换两个视图，见关联 UX 说明。
- 不写“正常 / 接近上限”这类健康状态文案；百分比、颜色和重置时间已经说明状态。
- Provider 图标保留品牌色，不做单色处理。
- 字号只用 12、14、18，最小 12px。
- 边框和分隔线统一 0.5px，不用 1px。
- 文案不使用中点分隔。
- 不写冗余解释；标签和值本身承担表达。
- 平面填充；不用渐变、发光、装饰性阴影或卡片左侧色条。
- 每类记录列表只用一张卡；不嵌套圆角面板。
- 同心圆角：卡片 14px，控件 8px，控件内的段 6px。
- 不做环境动画。需要动效时用 ease-out，250ms 左右。
- 光学对齐：区块标题和行共享左边缘；数字列右对齐。

## 数据与归属

| 信息                | 现有来源                                                                       | 需要补什么                                                                       |
| ------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Provider / 机器身份 | Agent configs、`MachineMeta`、会话的 `machineId` / `agentConfigId` / `modelId` | 按 Provider 配置聚合                                                             |
| Rate limit 窗口     | 机器 Flock 的 `raceLimits`，键为 `agentConfigId + limitId`；Provider RPC 刷新  | 解析 scope；离线机器保留上次快照                                                 |
| Tokens / 成本       | 会话历史里的 per-turn `tokenUsage`                                             | 本地增量 rollup；打开页面时不要扫描全部历史                                      |
| Deferred turns      | 尚未实现                                                                       | #361 durable `deferredTurn`：会话、轮次、机器、scope、deadline、状态、generation |

成本是估算值，不是账单。未知计价保持未知。用量桶和重置时间必须标明时区。

### 权限

Provider 账号身份和配额是账号级信息。只展示查看者本来就能在 Settings > Agents 里看到的机器和 Provider。工作区汇总可以包含成员用量，但不能暴露其他成员的 Provider 账号或配额。

## #361 的 UI 契约

| 状态                       | 显示                               | 动作           |
| -------------------------- | ---------------------------------- | -------------- |
| `scheduled`                | “18 分钟后重试”，已等待时间        | 取消、打开会话 |
| `waiting_for_machine`      | “等待机器上线”，已等待时间         | 取消、打开会话 |
| `dispatching` / `retrying` | “正在重试”，倒计时停止             | 只读           |
| `needs_attention`          | “需要处理”，投递结果不确定，未重放 | 放弃、打开会话 |
| `canceled` / `succeeded`   | 从等待列表消失                     | —              |

机器、配置、模型或模式缺失是可见的终态，绝不 fallback。新的 reset 会把 deadline 后移，显示“已推迟到 …”，不新增一条。

## 非目标

- 独立的全宽仪表盘路由。
- “正常 / 接近上限”文案，或重复 meter 已经表达的绿/黄徽标。
- 配额或等待恢复的假进度。
- 解析 Provider 错误文案；只认结构化 reason。
- 有 ACP 输出或工具活动之后自动重放。
- 把钱包余额画成窗口百分比，或伪造未上报的配额。
- 在等待列表里加第二套“立即重试”投递路径。

## 未决问题

1. #361 提供延迟轮次数据后，如何关联回相应会话？
2. 哪些已记录身份能支持模型/成员之外的准确消耗归因？
3. 现有 3D 日历继续保留在 AI 用量页，保留懒加载与每日详情。进一步改变设计需要单独决定。
4. 只给取消 + 打开，还是也做经过重新校验的“立即重试”？

## 证据

- 设计稿：`../../assets/ai-usage-dashboard/page.png`。
- 已实现页面：`packages/components/src/components/settings/ai-usage-setting.tsx`、`ai-usage-setting-view.tsx`、`ai-usage-model.ts`。
- 配额和等待 fixture 的 story：`packages/components/src/stories/AiUsageSettings.stories.tsx`。
- 原有区块参考：`settings-aiusagesettings--default`；AI 用量页：`settings-aiusagesettings--consumption`；Agents 配置/额度切换：`settings-aiusagesettings--agents-page`；初始选中额度：`settings-aiusagesettings--agents-quota`。
- 测试：`packages/components/tests/ai-usage-model.test.ts`、`tests/ai-usage-view.test.tsx`。
- 现有用量页面：`packages/components/src/components/settings/stats-setting.tsx`、`stats-setting-pure.tsx`、`settings-data-cache.tsx`。
- 配额读取：`packages/components/src/lib/session-usage.ts`、`packages/shared/src/schema.ts`、`packages/shared/src/machine-flock.ts`。
- Per-turn 用量：`packages/shared/src/session-data/token-usage.ts`、`apps/cli/src/lib/usage/`。
- Issue：[Lody #361](https://github.com/LodyAI/Lody/issues/361)。

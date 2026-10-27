# AI 用量：一页设置页，管配额、花费和等待恢复

Status: proposed
Type: feature
Translation: current

[English](2026-10-25-ai-usage-dashboard.md)

## 摘要

现在的 AI 用量是一个云端工作区的 token/成本报表。它回答不了哪个 Provider 账号现在能跑、哪台机器花掉了这些 token、哪些会话在等配额重置。rate limit 只出现在 Provider 行和 composer 弹层里；#361 的 deferred turn 没有界面。

本文提出在 Settings > AI 用量 里做一页，而不是独立的全宽看板或一组标签页。它沿用 Lody 设置页的材质：扁平页面、记录列表放在一张有分隔线的卡里、字号 12/14/18、边框 0.5px，不用装饰性色条和发光。同时提出本地优先的用量聚合，让没有 `usageAnalytics` 的开源本地组合也能渲染；并增加 durable 的 rate limit 采样，让页面能画出每个窗口的消耗和重置。

第一版 UI 已经落地；下文的 rate limit 采样和 #361 数据层还没有接。

## 实现状态（2026-10-25）

- 桌面 Settings > AI 用量 保留原有 `StatsSettingsView`（工作区标题、24h/7d/30d/全部、Token/费用大数字、3D 天际线、按模型/按成员、分享），在它下面追加实时配额、Provider/机器、配额历史和等待恢复。旧用量页面没有删。移动端仍用 `MobileStatsSettings`。
- 实时配额来自可见机器、它们的 agent config 和机器 Flock 的 `raceLimits`。页面会为每个在线且支持查询的 Provider 请求一次刷新，并提供手动刷新。
- 新的 Provider/机器 表沿用现有云端工作区 timeline，按 model id 归到 Provider。没有 `usageAnalytics` 的本地组合只显示实时配额和 Provider/机器 表，不伪造用量。
- `AiUsageSettingsView` 承载新增的配额、配额历史、Provider/机器 和等待恢复区块；`AiUsageSettings.stories.tsx` 用 fixture 覆盖它们。原有用量页仍是组合页面的上半部分。
- 第一版 Provider/机器 表去掉了占比条，给机器名留出可读宽度；Tokens、成本和配额保留。
- 原有用量视图保留：24h/7d/30d/全部 范围、Token/费用大数字、3D 天际线、当天明细和分享入口都留在原页面。原来的 by-model 和 by-member 两张图合并成下方的 Breakdown，用 Model/Member 切换。
- **还没接：** 机器侧 `rateLimitSample` 存储和 #361 deferred-turn 记录。历史和等待区块在有记录前保持隐藏；页面不伪造这两类数据。
- 验证：`@lody/components` typecheck 通过；`tests/ai-usage-model.test.ts` 和 `tests/ai-usage-view.test.tsx` 共 7 个测试通过。当前环境 Node 26.11.1 低于仓库下限，安装用了 `--ignore-scripts`，并手动构建了两个 ACP submodule。

## 场景

1. **还能不能继续？** 哪些 Provider 账号接近上限、窗口什么时候重置、账号属于哪台机器？
2. **钱花在哪？** 哪个 Provider、机器、模型产生了 token 和估算成本？
3. **什么被挡住了？** 哪些会话因为结构化配额限制失败、已经等了多久、什么时候重试？

页面按这个顺序回答。顶部只留一行提示指向被挡住的会话，完整列表放在页面底部。

## 提案

一页，五个区块：

| 区块 | 内容 |
| --- | --- |
| 实时配额 | 每个 Provider 账号一行：身份、机器、5h/7d 窗口、重置时间、余额或未上报 |
| 配额历史 | 5 小时窗口最近 24 小时；7 天窗口最近 7 天，来自采样 |
| 用量 | Tokens、成本、轮次、配额中断；一条按 Provider 堆叠的趋势 |
| Provider 与机器 | 每个 Provider/机器 一行：Tokens、成本、占比、配额 |
| 等待恢复 | #361 的会话，已等待时间、下一次动作、取消、打开会话 |

配额、归因、等待各是一张有行的卡。KPI 带和两组图表直接落在页面上。没有嵌套卡片、没有热力矩阵、没有标签页。

### 等待行为

- 显示**已等待时间和下一次重试**，不画进度条。
- **取消**是真正的本地控制：先停止自动重试，再通知 daemon；页面不等服务端确认。
- 已经渲染的结果保留，等待不会清空列表。
- deadline 已过但所属机器离线时显示 `waiting_for_machine`。
- `needs_attention` 对应“提交后 daemon 退出”的场景：本地没有输出不等于 Provider 没做事，因此不自动重放。
- 页面不拥有 timer 或调度权。它读取 durable 记录，并请求 daemon 取消。

## 设计约束

这些是 owner 的 taste review 定下的：

- 一页，放在设置页里，不新增独立路由。
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

| 信息 | 现有来源 | 需要补什么 |
| --- | --- | --- |
| Provider / 机器身份 | Agent configs、`MachineMeta`、会话的 `machineId` / `agentConfigId` / `modelId` | 按 Provider 配置聚合 |
| Rate limit 窗口 | 机器 Flock 的 `raceLimits`，键为 `agentConfigId + limitId`；Provider RPC 刷新 | 解析 scope；离线机器保留上次快照 |
| Rate limit 历史 | 目前没有 | 新的 `rateLimitSample`：按 machine、config、limit、window 记录 sampledAt、usedPercent、resetsAt；15 分钟一次，保留 14 天，离线断开 |
| Tokens / 成本 | 会话历史里的 per-turn `tokenUsage` | 本地增量 rollup；打开页面时不要扫描全部历史 |
| Deferred turns | 尚未实现 | #361 durable `deferredTurn`：会话、轮次、机器、scope、deadline、状态、generation |

成本是估算值，不是账单。未知计价保持未知。用量桶和重置时间必须标明时区。

### 配额采样（尚未实现）

每台在线机器每 15 分钟读取一次 Provider 的 `rateLimits`，记录按 machine、agentConfig、limitId、window 归档。页面按选定范围读取；机器离线或 Provider 不再支持查询时，曲线断开，不插值、不延长最后一段。5 小时窗口画在 24 小时视图里，避免几次重置被压成噪音；7 天窗口画在 7 天视图里。

### 权限

Provider 账号身份和配额是账号级信息。只展示查看者本来就能在 Settings > Agents 里看到的机器和 Provider。工作区汇总可以包含成员用量，但不能暴露其他成员的 Provider 账号或配额。

## #361 的 UI 契约

| 状态 | 显示 | 动作 |
| --- | --- | --- |
| `scheduled` | “18 分钟后重试”，已等待时间 | 取消、打开会话 |
| `waiting_for_machine` | “等待机器上线”，已等待时间 | 取消、打开会话 |
| `dispatching` / `retrying` | “正在重试”，倒计时停止 | 只读 |
| `needs_attention` | “需要处理”，投递结果不确定，未重放 | 放弃、打开会话 |
| `canceled` / `succeeded` | 从等待列表消失 | — |

机器、配置、模型或模式缺失是可见的终态，绝不 fallback。新的 reset 会把 deadline 后移，显示“已推迟到 …”，不新增一条。

## 非目标

- 多个标签页或独立的全宽仪表盘路由。
- “正常 / 接近上限”文案，或重复 meter 已经表达的绿/黄徽标。
- 配额或等待恢复的假进度。
- 机器离线或 Provider 不支持时补采样点。
- 解析 Provider 错误文案；只认结构化 reason。
- 有 ACP 输出或工具活动之后自动重放。
- 把钱包余额画成窗口百分比，或伪造未上报的配额。
- 在等待列表里加第二套“立即重试”投递路径。

## 未决问题

1. 顺序按 配额 → 配额历史 → 用量 → 归因 → 等待，还是把等待提前？
2. 15 分钟采样、保留 14 天可以吗？
3. Provider × 机器 的记录表够不够，还是仍然想要矩阵？
4. 3D 日历从这一页移除，还是保留在底部？现有日历是 `usage-calendar-visualization.tsx` 里用 three.js 画的立体日历，每天一格或一根柱，按 token 高低起伏，点开看当天明细。它需要懒加载，占空间。
5. 只给取消 + 打开，还是也做经过重新校验的“立即重试”？

## 证据

- 设计稿：`../../assets/ai-usage-dashboard/page.png`。
- 已实现页面：`packages/components/src/components/settings/ai-usage-setting.tsx`、`ai-usage-setting-view.tsx`、`ai-usage-model.ts`。
- 完整历史和等待 fixture 的 story：`packages/components/src/stories/AiUsageSettings.stories.tsx`。
- 组合页面 story（旧用量页 + 新区块）：`settings-aiusagesettings--composed`。
- 测试：`packages/components/tests/ai-usage-model.test.ts`、`tests/ai-usage-view.test.tsx`。
- 现有用量页面：`packages/components/src/components/settings/stats-setting.tsx`、`stats-setting-pure.tsx`、`settings-data-cache.tsx`。
- 配额读取：`packages/components/src/lib/session-usage.ts`、`packages/shared/src/schema.ts`、`packages/shared/src/machine-flock.ts`。
- Per-turn 用量：`packages/shared/src/session-data/token-usage.ts`、`apps/cli/src/lib/usage/`。
- Issue：[Lody #361](https://github.com/LodyAI/Lody/issues/361)。

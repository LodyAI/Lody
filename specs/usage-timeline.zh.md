# 用量时间线展示

Status: draft
Translation: current

[English](usage-timeline.md)

用户对照用量 skyline、By model 和 By member 时，同一个小时桶必须对应同一时间。
三种视图统一使用 UTC，与用量日历及日期详情标识一致。标签表示桶起点，午夜为
00:00。小时曲线标签包含日期和 UTC，明确跨日窗口。skyline 横轴按返回的桶顺序
生成，包括非午夜开始的窗口，不假设第一桶为 00:00。

小时面板显示返回窗口的起止日期、时间和 UTC。柱子的提示显示按窗口裁剪的桶区间，
包括首尾不足一小时的桶。七日矩阵包含返回窗口触及的每个 UTC 日期，可能跨八个日期。
点击柱子或点仍打开对应的 UTC 日期详情。桌面和响应式移动端使用同一选定时间线
及格式化规则。

切换到小时范围（24h、7d），或从小时范围切到其他范围时，关闭已选日期详情。
30d ↔ All 共用同一组日历格，因此保留选日。Resize 和 scroll 位置同步可以移动
当前选日的指示箭头，但不得重新打开已关闭的详情，也不得替换另一个选日。
切换范围后再次点击格子，应正常打开其日期详情。关闭详情不使日期缓存失效。

客户端对 `day` 和 `week` 请求 `granularity: hour`，使用返回的 `startMs`、
`endMs`、`bucketSizeMs` 及桶。本展示契约不重新定义服务端的范围选择或聚合算法。
日粒度桶保留服务端标签。数值、总量和费用估算透传；图表对齐不能证明账单正确性。

## 证据与限制

- [查询及返回结构](../packages/components/src/components/settings/settings-data-cache.tsx)
- [UTC 格式化](../packages/components/src/components/settings/usage-timeline-bucket-label.ts)
- [实际渲染回归](../packages/components/tests/usage-timeline.test.tsx)
- [跨日和不完整桶回归](../packages/components/tests/usage-share-stats.test.ts)
- [决策及验证边界](../.agents/notes/implemented/bug-fix/2026-10-01-usage-timeline-time-basis.zh.md)
- [选日生命周期与回调回归](../.agents/notes/implemented/bug-fix/2026-10-02-usage-range-selection.zh.md)

托管服务实现不在公共仓库内，其范围算法、聚合端点和生产返回尚未验证。

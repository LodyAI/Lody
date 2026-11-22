# 用量时间线展示

Status: draft
Translation: current

[English](usage-timeline.md)

用户对照用量 skyline、By model 和 By member 时，同一个小时桶必须对应同一时间。
三种视图统一使用设备时区，标签表示桶起点，午夜为 00:00。skyline 横轴按返回的桶顺序
生成，也适用于非午夜开始的窗口。空间允许时，小时标签包含当地日期和时区偏移。

小时面板显示返回窗口的本地起止日期、时间和时区偏移。柱子的提示显示按窗口裁剪的
桶区间，包括首尾不足一小时的桶。七日矩阵按当地日期和钟点放置返回的桶，重复的
小时各有独立格子。点击柱子或点会打开该桶对应的单日用量明细，标题标明 UTC。
30 天和全部时间的日历使用 UTC 日期。桌面和响应式移动端共用这些规则。

切换到小时范围（24h、7d），或从小时范围切到其他范围时，关闭已选日期详情。
30d ↔ All 共用同一组日历格，因此保留选日。Resize 和 scroll 位置同步可以移动
当前选日的指示箭头，但不得重新打开已关闭的详情，也不得替换另一个选日。
切换范围后再次点击格子，应正常打开其日期详情。关闭详情不使日期缓存失效。

客户端对 `day` 和 `week` 请求 `granularity: hour`，使用返回的 `startMs`、
`endMs`、`bucketSizeMs` 及桶。本展示契约不重新定义服务端的范围选择或聚合算法。
日粒度桶保留服务端标签。数值、总量和费用估算透传；图表对齐不能证明账单正确性。

## 证据与限制

- [查询及返回结构](../packages/components/src/components/settings/settings-data-cache.tsx)
- [本地时间格式和七日矩阵定位](../packages/components/src/components/settings/usage-timeline-bucket-label.ts)
- [实际渲染回归](../packages/components/tests/usage-timeline.test.tsx)
- [跨日和不完整桶回归](../packages/components/tests/usage-share-stats.test.ts)
- [本地显示与 UTC 日期标识](../.agents/notes/implemented/feature/2026-11-16-usage-local-time.zh.md)
- [桶起点决策](../.agents/notes/implemented/bug-fix/2026-10-01-usage-timeline-time-basis.zh.md)
- [选日生命周期与回调回归](../.agents/notes/implemented/bug-fix/2026-10-02-usage-range-selection.zh.md)

托管服务实现不在公共仓库内，其范围算法、聚合端点和生产返回尚未验证。

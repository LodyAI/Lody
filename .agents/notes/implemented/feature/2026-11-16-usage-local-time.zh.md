# 小时用量图表使用设备时区

Status: implemented
Translation: current

[English](2026-11-16-usage-local-time.md)

## 摘要

用户按本地时间对照每小时用量和实际活动。24 小时和 7 天交互图表按设备时区显示
同一组桶起点。日粒度统计由服务端按 UTC 日期提供，日历和单日明细明确标出该时区。

## 决策

[桶起点决策](../bug-fix/2026-10-01-usage-timeline-time-basis.zh.md)让各图表的标签保持一致。
七日图按每个返回桶的当地日期和钟点放置格子，回拨时为重复小时分别保留格子。提示里的
时区偏移用于区分时间戳。点击格子后，使用原始时间戳确定 UTC 日期键。跨午夜时，如果改用
当地日期作查询键，读出的会是另一段时间的统计。

## 验证

[浏览器测试](../../../../packages/components/tests/e2e/usage-timeline.spec.ts)使用新加坡设备时区
覆盖三张图表和 UTC 单日明细。[时间线测试](../../../../packages/components/tests/usage-timeline.test.tsx)
覆盖重复小时的定位。两组测试均使用合成数据。

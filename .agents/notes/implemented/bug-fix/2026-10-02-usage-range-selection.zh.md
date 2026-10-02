# 范围切换后保持用量选日关闭

Status: implemented
Translation: current

[English](2026-10-02-usage-range-selection.md)

## 摘要

用量页面在切换小时范围时已有清除选日的逻辑，但旧 resize 或 scroll 回调能够
重新选中该日期。当前时间线读数因此可能显示无用量，而独立日期查询展示完整日总量。
位置同步现在只更新当前仍被选中的日期，不通知查询容器。受控回调复现了缺陷并验证
修复；生产 bundle 与其具体回调时序尚未验证。

## 证据与决策

在 `ffc6f57f55f97dff60328c0c6433e1b0abf269bb`，
`UsageCalendarVisualization` 在 `hourlyRange` 变化时清除选日。
`UsageRangePanel` 和 `UsageHeatmap` 却都通过能够打开选日的 `selectDay`
提交箭头测量。退出动画保留的格子仍能通过小时面板的 `root.contains` 检查。
退出中的热图也在卸载前保留旧选日 prop、scroll 监听和 observer；其仍有效的
scroll 事件会产生同样的状态修改。

挂载式[原有测试套件](../../../../packages/components/tests/usage-timeline.test.tsx)
使用真实 `AnimatePresence`、合成数据、显式 resize 回调及注入时间。它先确认
reset 关闭了父查询选日与 UI，再证明旧回调在原源码上重新打开两者。
浏览器 RangeSwitching Story 重复 7d → 24h：收起开始后显式调用已捕获的
observer 回调，此时旧格仍在原容器中。原路径显示 Jul 13 “No usage”，同时
显示独立加载的 Jul 13 日期详情；修复后保持关闭。这是构造的浏览器回调，不能
证明已断开的原生 observer 必然在 cleanup 后投递。

两个面板现在使用独立的选日和位置回调。父组件先检查已有 `notifiedDayRef`，再
更新选日与收起内容的箭头位置。关闭选日会同步修改该 ref，因此测量不会复活已排队
清除的选日，也不会替换另一日期。匹配日期的位置更新不通知查询拥有者。原有 reset、
收起过渡和 observer 清理继续负责各自原来的职责。

无需清空缓存：[日期缓存决策](2026-09-21-usage-detail-cache.zh.md) 仍适用。
移除动画或增加 observer 专属取消机制会改变更多行为，且仍混合选日权限与布局同步。
[时间线 Spec](../../../../specs/usage-timeline.zh.md) 拥有范围切换语义；
[UTC 决策](2026-10-01-usage-timeline-time-basis.zh.md) 仍适用。

## 消融与验证

| 删除的保护                      | 11 项时间线测试的结果                   |
| ------------------------------- | --------------------------------------- |
| 小时面板 resize 改回选日入口    | 四项范围切换回归失败。                  |
| 热图 resize/scroll 改回选日入口 | 两项范围切换及旧日期替换新日期失败。    |
| 删除父组件日期保护              | 七项失败，包括未通知查询却重新打开 UI。 |
| 父组件仅检查存在非空选日        | 渲染面板中的新日期被旧日期替换。        |
| 保留最终全部保护                | 11 项全部通过。                         |

测试还覆盖 24h ↔ 7d、小时图 ↔ 日历图、30d ↔ All 保留选日、再次点击打开、
关闭后旧回调、过渡完成及可观察的箭头移动。四组相关用量/缓存测试共 45 项通过。
受控 observer 故意允许 disconnect 后投递已捕获回调，不能由该夹具推断真实原生
调度。截图使用 Storybook 合成数据，不提交到仓库。浏览器还验证 30d ↔ All
保留选日，返回 24h 时关闭，且没有页面错误。在 Node 26.10.0 / pnpm 10.20.0
下，全仓 `pnpm check`、`pnpm format`、`pnpm build`（本地桌面）和 docs check
通过。测试使用 `NODE_OPTIONS=--no-experimental-webstorage NODE_ENV=test`，让
jsdom 拥有浏览器存储。Docs 只有已有警告，没有 SHA 保护主题；构建保留已有的大
chunk 警告。生产环境、原生移动端验收和托管用量核算未运行。

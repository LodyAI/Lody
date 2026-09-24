# Usage 页面加载骨架屏

Status: implemented
Translation: current

[English](2026-09-22-usage-loading-skeletons.md)

## 摘要

Usage 设置页在数据到达时明显跳动：日历卡片要等查询和懒加载的 three.js
chunk 都就绪才出现（整块缺席再弹出）；堆叠面积图把加载中和空数据渲染成
同一个矮小的 "No usage data" 卡片；底部还有一个出现又消失的虚线
"Loading usage data" 框。现在加载是一个一等视觉状态：面积图按真实图表
高度渲染图形状骨架，独立的日历骨架同时承担 Suspense fallback 和查询在
途时的占位，底部加载框被移除。页面几何从首帧就稳定，数据到位后原地替换。

## 决策

- `UsageStackedAreaChart` 新增 `loading`/`loadingText`。`loading` 为真且
  无数据时渲染同款卡片框架 + 绘图区骨架（分层面积剪影、网格线、刻度占位，
  高度取 `CHART_HEIGHT_DESKTOP`/`CHART_HEIGHT_MOBILE`）+ 图例占位。已
  有数据的图表在后台刷新时保持挂载，骨架永不替换活数据。
- 新增无依赖 leaf `usage-calendar-geometry.ts`，存放真实可视化和骨架共用
  的 53×7 网格常量与热力图尺寸；`usage-calendar-model.ts` re-export 这些
  常量保持既有 import 可用。骨架只依赖该 leaf，不碰 three.js，lazy 边界
  （three.js 必须留在 `usage-calendar-visualization` 模块图内）保持完整。
- `UsageCalendarSkeleton` 按 range 镜像真实卡片的三种布局而非一套通用
  形状。共享 chrome（真实 i18n 标题/副标题、指标切换占位、分解条 + 五
  统计底带）之下按 `range` 分发到三个 body 变体:`day` = 环形列 +
  24 根 skyline 柱 + 小时轴;`week` = 环形列 + 7×24 点阵（含日行
  gutter)+ 小时轴;`month`/`total` = 53×7 年历热力图（月标签、
  weekday gutter、Less–More 图例行）。变体是 dispatcher 下的独立展示
  组件，骨架形状始终对应激活 range 即将渲染的可视化。
- `stats-setting-pure.tsx` 在 workspace 已选且 `usageCalendar` 为
  `undefined` 时渲染骨架，并将其作为 Suspense fallback。
  `getWorkspaceUsageCalendar` 返回非空日历（空 workspace 也会得到零值
  对象），所以选中后 `undefined` 仅意味着"查询在途"。
  `mobile-stats-settings.tsx`（静态引用可视化组件）采用相同门控。
- 移除底部虚线加载框；`loadingText` 复用既有 `workspace.usage.loading`
  文案做 `sr-only` 播报。
- KPI 卡片保留 "—" 占位，但值行预留了解析后的高度
  （`min-h-[4.25rem]` ≈ NumberFlow 在 2.75rem 字号上限下的 68px),
  总数到达时不再撑高。
- 加载中、真空、未选 workspace 三个状态保持区分：空态仅在 `loading` 为假
  且无 bucket 时渲染。

## 曾考虑的方案

- 保持真卡片挂载但隐藏内容、或把零值假数据喂进 `prepareChart`：否决——
  假数据可能经格式化路径泄漏，且 series 不同时仍会重排。
- 骨架直接 import `usage-calendar-model.ts` 取网格常量：否决——会把
  three.js 拉进所有消费方，破坏保护 landing/SSR 不被第二个 React 渲染器
  波及的 lazy 边界。

## 验证

- Storybook:`Loading` 渲染常驻骨架；新增 `LoadingTransition`
  （`latencyMs` 参数）演示骨架→加载完成的过渡；`Empty`/`NoWorkspace`
  语义不变。
- Playwright 录制了改动前后的过渡过程（仓库外临时文件），确认加载帧与
  加载完成页布局一致。
- `pnpm run typecheck` 中改动文件无错误（本 worktree 依赖未装全，存在与
  本改动无关的跨包 implicit-any 噪声）;`usage-calendar-model`/
  `usage-share-stats` 测试通过。

## 限制

- KPI 卡片加载中仍是文字 "—" 而非骨架条，仅预留了行高。
- 日历骨架在各 range 下与真实卡片实测高度完全一致（pill 行站在真实行盒
  上,`leading-[1.45]` 匹配字体的 normal 行高；Less/More 等静态标签
  直接渲染真实 i18n 文案），但细节（点密度、柱宽、month 高亮窗口）是
  示意性的而非像素级复刻；可视化布局常量变化时需同步维护。

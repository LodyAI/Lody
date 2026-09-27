# 将 Provider 就绪标记迁至 StyleX，保持视觉不变

Status: implemented
Translation: current

[English](2026-09-26-agent-readiness-stylex.md)

## 摘要

业务层采用 StyleX 后，Provider 就绪标记仍使用 Tailwind utility 和全局 CSS 旋转动画。
现在样式与组件一起由 StyleX 管理，状态、尺寸及 HTML 动画容器保持原样；组件为引导页
调用方提供明确的 avatar 外观。在固定动画相位后，浅色和深色主题下的六个
Storybook 场景在迁移前后的对比均为零像素差异。产品主题的 `--muted`
浅色混合仍作为组件内的颜色桥，因为共享 token 中没有完全相同的值。

## 决定

`AgentReadinessMark` 使用 StyleX 组合尺寸与状态规则，颜色和圆角读取已有的
`@lody/ui` 标题、次级文字、强调色、分隔线和圆角 token。保留原先 40% 的 `--muted`
背景混合，以维持产品主题下的原有表面；用近似共享 token 替换会改变这次纯样式迁移的
视觉结果。待产品主题定义对应的语义 token 后，可以移除这层桥接。

在这一层 Stack 中，引导页仍通过 `className` 传入 `rounded-full bg-muted/50`；
下一层迁移调用方时，可由标记的 `surface="avatar"` 属性选择这两条规则。默认 tile
保留 40% 的浅色混合，外部 `className` 仍可用于调用方布局。

旋转关键帧从 `tailwind/index.css` 移入组件。不定进度的 SVG 仍放在带动画的 HTML
`span` 内，维持[旋转动画决策](../bug-fix/2026-09-13-spinner-off-svg-retina-composite.md)
记录的 Retina 合成约束。调用方可选的 `className` 仍作用于外层标记，用于布局。

## 验证

使用同一提交的独立 checkout 安装 Storybook 依赖，当前 worktree 未安装依赖。Chromium
在固定的 640 × 500 视口下分别渲染迁移前后的 `Vocabulary`、
`InventoryFillingIn` 和 `Sizes` 场景，覆盖浅色和深色主题。等待字体加载，并将
不定进度圆弧在两版中固定到零相位。六张 PNG 对比均为零像素差异。组件类型检查及 StyleX
开发转换均通过。Chromium 还确认 40 px 的 HTML 容器运行 1.4 秒线性无限旋转动画，
启用减少动态效果后 `animation-name` 为 `none`。此对比覆盖上述渲染状态，不代表所有
宿主主题或设备缩放比例。

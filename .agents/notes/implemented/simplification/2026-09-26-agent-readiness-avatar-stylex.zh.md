# 引导页改用就绪标记的 StyleX avatar 外观

Status: implemented
Translation: current

[English](2026-09-26-agent-readiness-avatar-stylex.md)

## 摘要

[就绪标记迁移](2026-09-26-agent-readiness-stylex.zh.md)已将组件视觉规则移入 StyleX，
但引导页调用方仍通过 Tailwind 类覆盖颜色和圆角。这一层 Stack 改用标记的
`surface="avatar"` 变体，并增加 Storybook 场景以展示紧凑头像的各个状态。

## 决定

tile 和 avatar 两种外观均由标记组件负责。引导页选择语义变体，不再依赖 Tailwind
与 StyleX 的样式注入顺序。外部 `className` 仍可组合布局，但不再承担该外观覆盖。

## 验证

Playwright 在固定的 640 × 500 视口下分别渲染迁移前后的 `AvatarSurface` 场景，
覆盖浅色和深色主题。迁移前的 fixture 传入原有
`rounded-full bg-muted/50` 类，迁移后使用 `surface="avatar"`。字体和视口固定，
减少动态效果消除了动画相位差异，两组 PNG 均逐字节一致。结论仅覆盖这些采样视觉状态，
不代表所有宿主主题或设备缩放比例。

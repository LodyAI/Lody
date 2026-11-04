# 会话右侧栏拖拽手柄：居中的一块墨色

Status: implemented
Translation: current

[English](2026-10-31-session-sidebar-resize-handle.md)

## 摘要

桌面会话分栏过去在悬停或拖拽时画一条贯穿全高的 2px 强调色线，看起来像与右侧栏自身细线竞争的第二条分割线，而且完全没有键盘状态。现在手柄静止时不绘制任何内容，只在接缝中央露出一小块黑白块：悬停是柔和的 28px 高块，键盘聚焦时颜色更深、高度放大到 1.25 倍，拖拽时最深。指针目标仍由 12px 的命中区边距提供而非元素宽度，因此视觉不会改变面板几何，细线仍是唯一的分割线。已在 Storybook 中通过计算样式核对悬停、聚焦与拖拽三种状态；减少动态效果设置和打包后的 Electron 渲染未单独验证。

## 问题

- 旧的悬停线会整条覆盖右侧栏的左侧细线，分割线只是换色、加粗，并没有获得“可抓取”的提示。
- 它使用 `--sidebar-ring` 强调色；周围框架是黑白的，一条强调色线会被读成状态或选中信号。
- `react-resizable-panels` 让手柄成为可聚焦的 separator，但旧样式没有任何聚焦状态：全局焦点环画在 1px 宽、贯穿全高的元素上，键盘用户看不到焦点位置。

## 设计

- 手柄元素保持 1px 宽且透明；可见标记是 primitive 的子节点（`ResizableHandle` 现在会渲染调用方传入的 children，而不是内置抓手），因此块不会影响 flex 布局尺寸。
- 一块 3×28px 的 `rounded-full` 墨色块，静止时不可见。状态由库自带的数据属性与 `:focus-visible` 驱动：悬停 30% 墨色，聚焦 50% 墨色并 `scale-y-125`，拖拽 70% 墨色并保持同样的缩放。聚焦与拖拽同时在颜色和高度上与悬停区分，即使指针仍停在手柄上，键盘聚焦依然可辨。
- 该元素抑制全局内嵌焦点环（`focus-visible:shadow-none`），由墨块本身充当焦点指示。`aria-hidden` 让装饰块不进入无障碍树，separator 的角色与语义保持不变。拖拽光标仍由库负责（悬停时它把 `ew-resize` 写到 document 上），墨块不再引入第二个相互冲突的光标。

## 验证

- `packages/components/tests/desktop-session-detail-layout.test.tsx` 通过（11 项）；`@lody/components` 的 `tsgo --noEmit` 无错误。
- 在 Storybook `Sessions/DesktopSessionDetailLayout` 中用计算样式测得：静止 `opacity: 0`；悬停 `3×28`、30% 墨色；聚焦 `3×28` 并缩放 1.25、50% 墨色、`focus-visible` 为真、box-shadow 透明；拖拽 70% 墨色。截图确认静止时没有任何绘制。
- 未验证：减少动态效果下的时序、深色主题的目视效果，以及打包后的 Electron 窗口。

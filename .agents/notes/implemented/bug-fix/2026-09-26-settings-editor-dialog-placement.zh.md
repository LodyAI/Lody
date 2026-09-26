# 设置编辑器居中于内容区，关闭时保留内容

Status: implemented
Translation: current

[English](2026-09-26-settings-editor-dialog-placement.md)

## 摘要

设置里的编辑器对话框（Agent 角色、MCP 服务器、Prompt 快捷指令）原先以窗口为基准居中。
设置浮层左侧有 240px 的导航，编辑器因此压在导航和内容区的交界上，而不是打开它的那一页上。
按 Esc 关闭时还会闪烁：第一帧内容就消失了，面板缩成只剩标题，然后才淡出。
现在编辑器居中于内容区：`@lody/ui` 模态面板新增 `centerOn` 属性，把测得的内容区中心交给面板。
另外，在 Base UI 报告退出过渡结束前，编辑器一直渲染关闭时的那份值。
最初尝试的是 CSS anchor positioning，后来放弃了，因为 Electron 自带的 Chromium 解析 `anchor()`
时没有计入设置面板用来居中的 transform。

## 位置

`SettingsPaneHeaderProvider` 现在同时携带内容区元素，由 `useSettingsPane()` 取出。
`Dialog.Content` 和 `AlertDialog.Content` 接受 `centerOn?: Element | null`。
`useInlineCentre`（`dialog/parts.tsx`）在 layout effect 里测量元素的水平中心，所以首帧绘制时位置就已经对了。
它在元素的 `ResizeObserver` 和窗口的 `resize` 时重新测量：设置面板在窗口中居中，
可能只移动而不改变尺寸。面板得到内联的 `inset-inline-start`：`clamp(reach, <centre>px, 100% - reach)`。
其中 `reach` 等于面板宽度的一半加上 `dialog.inset` 的一半，所以窗口较窄时面板会被拉回窗口内，
而不会被推出边缘。声明写在内联样式里，理由与 `width` 相同：同一属性的第二个 StyleX class
谁生效取决于样式表顺序，而不是调用方。

只移动行内轴。内容区与设置面板同高，而设置面板本身在窗口中居中，所以块轴上的中心本来就一致。
没有元素时（composer 的 Role 选择器、移动端设置路由），面板仍以窗口居中。

考虑过的方案：

- **CSS anchor positioning**：在内容区声明 `anchor-name`，在 clamp 里用 `anchor()`。
  独立的 Chromium 154 页面里位置正确。但在构建出的桌面应用（Electron 39）里，
  `anchor(--settings-pane left)` 解析为 830px，而内容区实际从 334px 开始。
  相差的 496px 恰好是设置面板宽度的一半，也就是它的 `translate(-50%, -50%)`。
- **把编辑器 portal 进内容区**：会让设置面板的 `transform` 成为包含块，遮罩也会被裁在内容区内。
- **写死 `50vw + 120px`**：一旦导航宽度变化就会悄悄错位。

## 关闭不闪烁

这些对话框由一个值打开（`open={editor !== null}`），清空这个值来关闭。
`useDialogExitSnapshot`（`hooks/use-dialog-exit-snapshot.ts`）把最后一个非空值作为 `shown`
返回，并在 root 的 `onOpenChangeComplete(false)` 里清掉，于是表单会和面板一起淡出。
`open` 仍然读实时值。Role 编辑器的 `onChange` 和 `save` 也走实时值，所以淡出期间的编辑不会让对话框重新打开。
`machine-agent-settings.tsx` 曾用单独的 open 标志为 Agent 配置对话框解决过同一个问题；
这个 hook 是那种做法的可复用形式。

## 验证与限制

一个未提交的临时桌面 E2E 场景，在 1180px 宽的窗口里，于构建出的 Electron 应用中打开「设置 → Agent 角色 → 添加角色」。
内容区中心和编辑器中心都在 710px。按下 Esc 后逐帧采样，编辑器在透明度降到 0 之前一直保留名称输入框和 606px 的高度，
随后才卸载。`packages/ui/test/dialog.test.tsx` 覆盖了测得的中心、窗口缩放时的更新，以及以窗口居中的回退。
`packages/components/tests/dialog-exit-snapshot.test.tsx` 保持退出动画不结束，断言 `data-ending-style`
期间内容仍在；hook 改回直接返回实时值时，这个测试会失败。窄窗口下的夹紧只在独立的 Chromium 页面里验证过，
没有在 Electron 里验证。

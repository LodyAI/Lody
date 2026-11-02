# 平板：走桌面端交互，而不是拉长的手机 sheet

Status: implemented
Translation: current

[English](2026-10-27-tablet-desktop-layout.md)

## 摘要

大平板走桌面端交互。手机全高新对话 sheet 只留给手机和窄分屏，不再为平板生长出
专属布局。现有 `MOBILE_LAYOUT_BREAKPOINT` 决策已经实现了这一点，所以没有改渲染代码。
平板专属变体（居中列、分栏、卡片）均否决，只作为备选留在 artboard。

## 决策

- 设备宽度达到 `MOBILE_LAYOUT_BREAKPOINT`（768px）——包括 iPad 竖屏/横屏——走桌面
  家族；低于它（Split View、Slide Over、小尺寸平板竖屏）才可能走移动端。
- 移动端的新对话 compose sheet 和 `MobileNewChatProjectSheet` 是手机/分屏界面，
  不要给它们加平板专属版本。
- 大平板上的项目、机器、分支和 run config 继续用桌面选择器，而不是移动项目 sheet。

## 原因

834px 的强制移动预览把代价暴露得很直接：输入提示贴着屏幕左边，footer 铺满整行，
发送按钮离 chips 几百点。居中列（T1）、上下文分栏（T2）、卡片（T3）都会多出第三个
要维护的布局家族；桌面 landing 已经提供了这个宽度应有的交互。

## 否决的备选

- **T1 — 居中 680px 列**：改动最小，但仍是平板专属的第二套布局。
- **T2 — 左侧上下文分栏 + 右侧写字**：利用宽度，但移动了控件，重复桌面结构。
- **T3 — 720px 居中卡片浮在首页上**：更像 iPad 原生 modal，但和手机、桌面都不是同一种形态。

## 证据

- `packages/components/tests/mobile-layout-selection.test.tsx` 固定了 1280 宽 Android
  平板 → 桌面、834 竖屏 iPad → 桌面、600 分屏平板 → 移动端。
- 决策沿用 `use-mobile.ts` 的现有注释和 [ui-mobile.md](../../../docs/ui-mobile.md)。
- 决策后已从 Ryugi artboard 移除平板变体；强制移动的平板截图只作为标注过的响应式检查，
  不是目标形态。

## 结果

没有改渲染代码。artboard 不再保留平板决策；UI-mobile 文档明确写出边界；834 竖屏
iPad 的测试防止未来“让 sheet 适配平板”的改动悄悄把拉长手机的状态带回来。Split View 的真机
验证仍未做。

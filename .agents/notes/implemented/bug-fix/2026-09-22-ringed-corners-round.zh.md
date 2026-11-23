# 带环控件改用圆角

Status: implemented
Translation: current

[English](2026-09-22-ringed-corners-round.md)

## 摘要

squircle 角上的 focus ring 在 Chromium 里会明显鼓出角切点之外——浏览器把
superellipse 上的扩散 `box-shadow` 画成 `superellipse(radius + spread)`，而这不是
原曲线的平行偏移。在 10px 半径的输入框上，2px accent 环与绘制边缘之间的间隙在角部
从 2px 涨到约 7px，看起来就是边框溢出了控件。所有边缘携带环的控件——field 家族
well、Button、Toggle、disclosure 的行/标签/面板——改用 `corner.round`：圆形角的
扩散阴影是真正的平行曲线。从不带环的表面保留 `corner.shape`，popup 表面的 0.5px
发丝环也保留——其发散量不足一像素。

## 发现

报告来自一张密码输入框截图：accent 环在角部脱离框体。像素测量显示环在直边上贴合
（2px，符合设计），但角部间隙放大数倍。在 Chrome 153 上用裸 `corner-shape: squircle`
+ `box-shadow: 0 0 0 2px` 元素复现：阴影的角弧是被缩放的 superellipse 而非平行偏移，
在切点附近向外漂移。`outline` 的发散数值逐点一致——Chromium 对所有描边图元走同一条
参量化路径——伪元素边框、嵌套 accent 层也撞同一堵墙：CSS 无法表达 superellipse 的
平行偏移。

## 备选

- 保留 squircle 接受楔形发散：artifact 在 Retina 截图上最明显，但 1x 下也存在，相对
  框体边缘读作缺陷。
- 环改成内描边而非外环：border 的外缘即控件自身 squircle，永远不会溢出——但设计
  语言会从偏移外环变成贴边边框，还要预留 border-box 空间。
- 全局去掉 `corner-shape`：卡片、菜单、对话框上没有环、没有问题的地方也丢了
  squircle。

带环控件用 round 保住了外环设计，只在小控件上牺牲 squircle——10px squircle 和
10px 圆本来已难分辨。这是对既有 `radius.full` 例外的扩展，而非新机制。

## 结果与限制

`corner.round` 落在 `field/well.ts`（`base`/`shell`/`box`）、`button`、
`toggle/surface.ts`、`disclosure/surface.ts`（`tab`/`tabPanel`/`row`），以及 gallery
里两块演示带环态的 focus replica。不变量写进 `packages/ui/AGENTS.md`，
`test/toggles.test.tsx` 断言 round 类抵达渲染出的 Checkbox、Input 和 PasswordInput
shell。验证方式：在 Storybook 里对聚焦字段做像素测量，环到边的间隙沿角恒定。

限制：这是 Chromium 渲染器的简化实现；未来若有真正的平行偏移实现，squircle 环会重新
贴合，但目前 CSS 无法强制。非 Chromium 引擎忽略 `corner-shape`，本来就走 round 回退。

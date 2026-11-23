# 移动端首页 workspace 头像裁切

Status: implemented
Translation: current

[English](2026-10-05-mobile-workspace-avatar-crop.md)

## 摘要

移动端首页将 32px 的 workspace 方形头像放在 36px 的圆形控件内，露出了方形
边角和多余间隙。首页现在放大共享头像以填满控件，并通过圆形遮罩裁切。
切换按钮和静态身份标识使用相同展示，其他位置的 workspace 头像仍保留共享
方形尺寸与外观。

## 决策与证据

[头像迁移](../feature/2026-09-13-ui-avatar-kbd.md)统一了 workspace 方形头像，
但当时没有渲染移动端首页进行验证。`HomeWorkspaceAvatar` 仍使用 32px 的
`large` 档位，而外层控件为 36px。首页拥有的 StyleX 包装层按 36/32 放大头像，
并在控件尺寸处裁切，保留共享图片缓存、等比例填充和回退显示。
这样无需覆盖基础组件的类名，也不必全局修改头像尺寸档位。

现有 `MobileHomeScreen` Storybook 套件新增了合成非正方形图片场景，分别覆盖
有无 workspace 菜单回调的情况。原有首字母场景覆盖无图状态。
原生设备渲染仍需单独验证。

## 验证

Chrome 在 393×852 视口下以浅色和深色主题渲染了两个图片场景和首字母场景。
浏览器测量确认头像、遮罩和外层控件占据相同的 36×36 矩形；遮罩裁切溢出内容，
图片保留 `object-fit: cover`。已查看截图进行视觉检查。

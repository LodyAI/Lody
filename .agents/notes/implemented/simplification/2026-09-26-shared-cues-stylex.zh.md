# 将共享视觉提示保留在组件内的 StyleX

Status: implemented
Translation: current
PR: [#1012](https://github.com/LodyAI/Lody/pull/1012)

[English](2026-09-26-shared-cues-stylex.md)

## 摘要

会话拖放遮罩、DeepSeek 委派提示和 MCP transport 图标是仍依赖 Tailwind
绘制的三个小型共享组件。现在各自的视觉规则放在组件内的 StyleX 定义中，语义角色、
文案和调用接口保持不变。拖放遮罩仍按应用主题选择不同透明度，不跟随操作系统主题。
固定条件下的十二个浅色／深色 Playwright 场景均为零像素差异。

## 决定

三个提示各有归属，不合并成共享视觉 helper：拖放遮罩是页面级状态覆盖，
委派提示是带链接的运行配置文案，transport 图标属于 MCP 设置。因此各自保留简短的
`stylex.create` 定义。颜色读取映射到产品主题的 `@lody/ui` 强调色、正文、
背景和警告 token。

拖放遮罩浅色 55%／12%、深色 45%／16% 的强调色薄层属于既有外观常量，
不是新的调色板角色。StyleX 选择器跟随应用明确的 `.dark` 类；当用户手动选择
与操作系统不同的主题时，媒体查询会得到错误的透明度。虚线框的 16px 圆角和
小阴影保持原值，因为共享 token 没有像素等价项。遮罩继续不接收指针事件：
命中测试由父级拖放区域负责。

## 验证

Playwright 在 800 × 760 视口下渲染隔离的会话引用／文件遮罩、真实 chat landing
遮罩、桌面布局的委派提示，以及 stdio／HTTP MCP 表单，均覆盖浅色和深色主题。
原版 Tailwind 与新版 StyleX 使用相同 Storybook fixture、视口、字体加载、
减少动态效果设置及隐藏的输入光标。十二组 before/after PNG 对比均为零像素差异。
当应用主题为深色时，无论操作系统偏好为浅色还是深色，Chromium 都报告了相同的
遮罩边框与填充颜色。`@lody/components` 类型检查通过。结论覆盖这些宿主界面和
主题采样，不代表所有设备缩放比例或自定义主题。

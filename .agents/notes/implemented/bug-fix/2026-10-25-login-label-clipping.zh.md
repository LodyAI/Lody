# 保留登录标签的字母下伸部

Status: implemented
Translation: current
PR: [#1879](https://github.com/LodyAI/Lody/pull/1879)

[English](2026-10-25-login-label-clipping.md)

## 摘要

登录方式标签裁掉了 Google 中“g”等字母的下沿。省略号容器继承了 Button 的 13px 行框，
而实际文字占据 18px。标签现在使用现有的 subheadline 行高令牌，为完整字形留出空间，
同时保留横向省略号和 36px 的按钮高度。

## 决策与证据

[登录界面](../../../../packages/components/src/components/login-page.tsx)拥有标签的溢出裁切，
因此也负责其行高。这细化了[登录视觉决策](../feature/2026-10-17-login-inset-visual-last-used.md)
中的标签布局。修改共享 Button 会影响无关控件；移除 overflow 会丢失“上次使用”徽标旁的
文字截断。局部标签改用随文档字号变化的 `text.subheadlineLeading`。

Playwright 配合 Chrome 在中英文、1280px 和 390px 视口、明暗主题下均复现了修复前的裁切。
修复后，全部八种组合中，带“上次使用”徽标的 Google 按钮在开启标签裁切与临时关闭裁切时
像素完全一致。标签高度为 18px，按钮仍为 36px。前后截图也展示了完整的第三方登录按钮组。
这些检查使用合成 Storybook 状态，不涉及真实登录。复用安装目录存在无关的 ACP 依赖解析
错误，阻塞仓库检查；浏览器验收使用临时配置将相应依赖指向本地源码。

# 紧凑的权限控件与完整的选项文案

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/1584

[English](2026-10-15-permission-option-wrapping.md)

## 摘要

过长的权限选项名会让拒绝按钮超出提示卡片，并让菜单中的后续授权范围被省略号截断。
提示组件现在保留短选项的直接点击操作，将直接选项过长的整组回答放入紧凑的菜单入口。
菜单左对齐显示完整 Provider 原文，并在视口内换行。长选项需要多一步展开菜单；
六个独立浏览器场景和三个聊天底部场景已在 Storybook 中通过，原生应用中的待授权请求交付仍未验证。

## 决策与职责

本次修复补充[分组按钮决策](../feature/2026-09-24-permission-prompt.md#fifth-review-split-buttons)，
更新既有的草案[权限展示契约](../../../../specs/permission-requests.zh.md#契约)。
直接让按钮文案换行，会产生大块居中段落，旁边挂着小箭头。视觉审阅否定了这一方案：
它解决了溢出，却让权限提示超出了输入框的尺度。

[PermissionPrompt](../../../../packages/components/src/components/sessions/floating-permission-request.tsx)
负责紧凑控件的文案预算：32 个字符位置，Latin-1 范围之外的字符按两个位置计数。
直接选项超出预算时，整组回答进入菜单，保留 Provider 顺序与选项原文。
入口按直接选项的语义显示“拒绝”“允许”或“选择回答”，仅表示分组，点击不会提交选项。
短选项保持既有的直接回答和可选分裂菜单交互。直接回答和箭头使用 `ButtonGroup`，共享一条接缝，
不引入多行 Button API。

分组内的 Button 会标记自己为一个分段。圆角选择器仅统计这些标记，忽略 Base UI 在菜单展开时
插入的焦点占位元素。否则入口不再是最后一个 DOM 子元素，会丢失外侧圆角。
此处理覆盖所有按钮尺寸和 pill 形状；原先只检查类名的分组断言由浏览器中的实际几何检查替代。

菜单中的 Provider 标签保留空白，允许长路径换行，最大宽度为 32em，并在弹出菜单既有的
视口限制内收缩。元素子节点绕过原语自动添加的省略包装，其他菜单不受影响。
提示替换位于聊天底部的输入框，因此菜单明确优先向上展开，并保留 Base UI 的视口碰撞规避和 Portal 挂载。
此前默认优先向下时，底部空间不足也通常会自动翻到上方；先前将卡片放在页面上方的截图无法证明聊天底部的行为。
方向键仍聚焦该组控件；Enter 展开长选项菜单，选择原文行后提交原始选项 ID。
提示卡片上的 Escape 继续执行单次拒绝。

## 验证与限制

[权限 Stories](../../../../packages/components/src/stories/PermissionPrompt.stories.tsx)
提供合成的中英文长选项名、长路径与可见的已选 ID 结果。
九个[浏览器用例](../../../../packages/components/tests/e2e/composer-submission-focus.spec.ts)
已通过 Playwright 1.58.2 与 Chrome 在完整 Storybook 服务中执行：

- 六个独立场景在 320、390、1280 像素宽度下检查紧凑控件、卡片边界、完整菜单文本，以及先展开菜单再提交原始 ID。
- 三个完整会话页面集成场景覆盖 1280×800、390×844、390×420，检查分组接缝、直角内侧和菜单展开时的外侧圆角、
  向上展开位置、视口边界，以及通过命中测试确认菜单没有被聊天容器裁切。

权限组件套件的 15 个测试通过；UI 包的 25 个文件、299 个测试及包级类型检查全部通过。
依赖通过忽略的链接复用已有完整公开 checkout，`@lody/ui` 指向本工作树修改后的源码。
完整会话页面 Story 使用真实页面、消息流、会话栏宽和权限组件，搭配合成会话数据，
不驱动真实守护进程或 Provider 请求。已目视检查安装版桌面的底部输入区位置，但原生应用中待授权请求的交付仍未验证。

忽略产物 `.lody/permission-acceptance/screenshots/` 保存基线、早期方案以及完整聊天页面的桌面、手机和短视口菜单截图。
完整聊天截图已上传到本任务对话。

根目录 `pnpm format`、`pnpm lint:i18n`、Oxfmt 0.65.0 和 `git diff --check` 通过。
`pnpm check` 在未修改的 `e2ee-core` 包因缺少依赖而中止。
组件包类型检查也报告其他模块的缺失依赖与既有错误，修改的提示组件和 Stories 没有诊断。
公开边界检查报告缺少 ACP 子模块工作区；`docs check` 报告 82 个指向这些缺失子模块的断链，
本次修改的文档没有错误。仓库未注册受 SHA 保护的文档主题。

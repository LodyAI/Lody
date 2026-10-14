# 移动端 HTML 文件预览

Status: implemented
Translation: current
PR: [#1525](https://github.com/LodyAI/Lody/pull/1525)

[English](2026-10-13-mobile-html-preview.md)

## 摘要

移动端 HTML 文件此前默认显示源码，WebKit 又因不支持 credentialless iframe 而无法使用现有的脚本预览。现在会话文件查看器与项目文件浏览器默认预览完整 HTML，小眼睛按钮可切换回原始源码。不支持 credentialless 的浏览器使用禁用脚本、移除跳转入口的文档，并放入不授予任何权限的 iframe 沙箱。此路径可以展示内联 HTML/CSS 与嵌入媒体，但不能运行交互脚本或加载同目录资源。

## 决策与职责

会话查看器在支持 credentialless 的浏览器中保留现有 Managed Preview，由移动端调用方选择初始预览模式；桌面端仍默认显示源码。`ReadOnlyHtmlPreview` 负责兼容 iframe，`buildReadOnlyHtmlPreviewDocument` 负责文档策略。独立项目浏览器没有会话批注上下文，因此所有浏览器均使用只读预览。

只读文档移除脚本、嵌套文档、模板、刷新标签、跳转属性和 SVG 属性修改。CSP 禁止脚本与网络资源，空 iframe 沙箱独立禁止脚本、表单、同源访问、弹窗和顶层跳转。没有采用直接移除可执行预览 credentialless 检查的方案，因为不透明来源本身不能隔离任意自导航请求的凭据。原有可执行路径及其限制见[浏览器行为](../../../docs/sessions-browser.md)。

本地项目读取此前会丢失传输返回的文本截断标记。现在 provider 和查看器转换都会保留该标记，截断 HTML 仅显示源码。不改变传输上限、文件授权、传输协议或原生壳能力。本次仅涉及普通 React 和文档转换，不需要 Effect 生命周期迁移。

## 验证

单元覆盖检查源码切换还原、隐藏时移除 iframe、文档策略、截断标记传递及禁止预览。浏览器验收覆盖两个移动入口、源码切换，以及脚本和跳转不生效。52 项针对性单元测试、两项 WebKit 验收、类型、格式、i18n、边界与文档检查均通过。根目录 `pnpm check` 停在未改动的 CLI 递归 SSH 子模块测试，Git 凭据报错为 `context_unreadable`，全仓测试未全绿。命令见 PR 测试计划。WebKit 浏览器验证不能替代原生设备验收。

## 附件弹窗补漏（2026-10-14）

PR #1525 未覆盖 `SessionFilePreviewDialog`：聊天附件无法打开实时文件或已有／已报告的浏览器目标时，会回退到这个弹窗。该面板此前只渲染 Markdown，因此合并后移动端 HTML 附件仍可能显示源码且没有小眼睛。此前两个浏览器场景没有验证这第三个入口。

现在附件面板默认用相同的只读组件预览完整 HTML，小眼睛放在原有标题栏的复制按钮旁。保留弹窗、文件信息、复制／下载／关闭按钮与 55vh 内容高度上限。复制始终返回原始文本，截断 HTML 仅显示源码。读取、授权与已有的附件跳转路径不变，也不引入新的 Effect 边界。

浏览器覆盖直接验证真实附件面板与弹窗，包括源码切换、剪贴板原文、移动宽度、关闭时移除 iframe 和截断场景。原生设备发布验收仍待进行。

本次补漏通过 4 项 WebKit 验收、48 项针对性单元测试，以及全仓类型、格式和文档检查。根目录 `pnpm check` 仍停在未改动的 CLI 递归 SSH 子模块测试，报错 `context_unreadable`（CLI 4,186 项通过、1 项失败），不能视为全仓测试通过。另已检查移动尺寸的附件弹窗截图。

单独补跑的 `pnpm check:quick` 已通过全部静态、i18n 与边界检查。

# 编程 Agent GUI 与远程工作流页面

Status: implemented
Translation: current

PR: [#1150](https://github.com/LodyAI/Lody/pull/1150)

[English](2026-09-30-coding-agent-workflow-pages.md)

## 摘要

寻找编程 Agent 图形界面或远程工作流的读者，需要集中了解 Lody 跨 Agent 的作用。
两个英文营销页面通过现有营销外观和真实公开产品截图，将这些用途连接到配置文档。
页面区分 Agent 运行时与模型服务预设，也承认厂商已经提供官方界面。
列出集成不代表功能完全一致，也不代表所有客户端组合均完成真实模型端到端验证。

## 决策与依据

- `/coding-agent-gui/` 说明会话、worktree 和审查流程；`/coding-agent-remote-control/`
  说明执行机器要求，并为 Claude Code 和 Codex 提供独立章节。两页复用六种集成卡片和原生 FAQ 折叠项。
- 具体配置仍由中英文 Agent Config 和移动端文档负责。文案依据这些文档、快速开始、
  Claude 与 Codex 能力文档及 [Pi 契约](../../../../specs/builtin-pi.zh.md)。
  GLM 是 Claude Code 的模型服务预设，Harness 与 DeepSeek over Claude Code 不同，
  Kimi 和 Pi 是能力取决于版本的托管运行时。
- 远程工作要求执行机器保持唤醒、联网且 CLI 持续运行。移动端实时编辑仍为即将支持，
  没有新增加密或自托管保证。
- 已于 2026-09-30 检查官方指南：[Claude 远程控制](https://code.claude.com/docs/en/remote-control)、
  [Claude 桌面端](https://code.claude.com/docs/en/desktop)、[OpenAI 应用](https://developers.openai.com/codex/app/)、
  [Codex Cloud](https://developers.openai.com/codex/cloud/)、[Kimi Web](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/web.html)、
  [Kimi 远程控制](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/remote-control.html)、
  [Harness](https://github.com/deepseek-ai/deepseek-harness) 及其可选的
  [Schedule overlay](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/schedule/schedule/README.md)。
  现有 Harness 警告指向[上游讨论 4065](https://github.com/deepseek-ai/deepseek-harness/discussions/4065)。

## 结构与取舍

薄路由 → 共用页面 head 与营销组件 → 现有配置文档。`collectSitePaths` 负责静态发布，
`site-url.mjs` 仅按[目录 URL 规则](../bug-fix/2026-09-30-public-site-directory-urls.zh.md)注册两个英文路由。
纯英文页面省略语言切换，避免生成不存在的对应语言页；页脚和文档提供原生链接入口。
无需为每个服务重复建入口页、编造截图、引入应用源码或新建交互演示。

## 验证与限制

站点类型检查、单元测试和生产构建通过，PR 记录最终生成 HTML、元信息、链接与 sitemap 验证。
现有生产浏览器套件增加桌面/移动端、禁用 JavaScript、主题、FAQ 和前进后退导航场景。
Chromium 无法创建本地 socket，云浏览器也拒绝 loopback 预览 URL，因此交互验证未能运行。
不能将新增场景视为已执行或 Agent 运行时测试。

仅安装站点依赖时，通过被忽略的本地符号链接提供已有隐式 `tw-animate-css@1.4.0` 依赖。
CI 暴露了已有 Codex adapter 与根 lockfile 不一致，以及 CLI 格式检查问题。main 随后通过
[#1148](https://github.com/LodyAI/Lody/pull/1148) 修复了两者，本分支同步上游修复，包含 Codex 0.159.2
完整平台 lock 条目，无需修改依赖隔离规则或 submodule pin。22 个 workspace 项目的冻结 lockfile
验证、根级格式检查、初始化 submodule 后的文档检查和公开仓库边界检查通过。
精确的已完成检查和限制记录在 PR 摘要中。

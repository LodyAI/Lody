# 文档内容清理：主 Agent 表述、删除过时对比与「功能列表」分组名

Status: proposed
Translation: current
Language: [English](2026-10-06-docs-content-cleanup.md)

## 摘要

文档里仍残留着对某个一等 Agent 的预设，以及已移除设置的说明。本提案把多 Agent 协作
指南改成不绑定具体 Agent（由主 Agent 协调其他 Agent，去掉 Claude Code 专属表述），
从会话交接对比里删除 Lore 和 SpecStory，删除不再支持的 VS Code 主题页面，把侧边栏
「参考」分组改名为「功能列表」，并说明多标签会话的关键是让不同的 Agent 复用同一个
工作区。中英文内容、信息架构草稿 Spec 和文档简介会一起更新；由于站点没有运行时重定向
层，被删除页面的 URL 会直接 404。

## 问题

- 多 Agent 协作指南把 Claude Code 固定为统筹者，但任何已配置的 Agent 都可以使用跨会话
  工具；指南还介绍了一项 Claude Code 专属的原生能力，而不是保持 Agent 无关。
- 会话交接页把 Lody 和 Lore、SpecStory 两种外部产品放在一起对比，表格变长，对读者
  选择交接方式没有帮助。
- VS Code 主题已不再支持，但页面仍在说明已移除的设置，并留在侧边栏中。
- 侧边栏「参考」分组低估了这组页面的性质；用户要求的名称是「功能列表」。
- 多标签会话的简介描述了并行工作界面，却没有点出关键：不同的 Agent 复用同一个工作区、
  看到同一份文件。

## 决策

- 把 `agent-collaboration` 指南在中英文里都改写成以「主 Agent」/「a primary agent」为
  统筹者；统筹是用户用任意已配置 Agent 承担的角色。删除 Claude Code 原生 Agent Teams
  的句子，而不是把它安到主 Agent 上。同步更新 `session-orchestration` 和
  `parallel-agents` 里的入链文案。
- 从 `session-handoff` 的对比表里删除 Lore 和 SpecStory 两行，并删除 FAQ 中对它们的
  点名；保留 ChatGPT 式分享链接作为只读记录的示例。
- 删除中英文的 `vscode-themes.mdx`，从 `(reference)/(settings-and-cli)/meta.json`
  中移除，并删掉内嵌终端页面对「所选代码主题」的引用。功能已不支持，因此删除页面而不是
  标记废弃。
- 把 `(reference)` 分组的显示名从「参考」/「Reference」改为「功能列表」/
  「Feature List」，并同步更新草稿 IA Spec、IA 记录和文档简介文案。目录名和已发布
  URL 保持不变。
- 扩写 `session-tabs` 简介，说明不同的 Agent 复用同一个工作区：同一份文件、同一个
  分支和同一批未提交改动，但各自保留对话历史。

## 考虑过的替代方案

1. 保留 Claude Code 专属指南，另加一句说明其他 Agent 也能统筹。否决：指南正文和入链
   仍会读成 Claude Code 教程。
2. 把 Lore 和 SpecStory 作为历史对比保留。否决：它们是外部产品，不是读者正在二选一的
   Lody 能力。
3. 只把 VS Code 主题标记为废弃，不删除页面。否决：设置已经不存在，继续教用户配置比
   404 更糟。
4. 只改中文侧边栏，英文继续叫 Reference。否决：中英文目录按约定保持相同的分组名。
5. 保留多标签会话原有表述，另加一条 FAQ。否决：共享工作区是这项功能的定义性特征，
   应该放在简介里。

## 验证与边界

- `pnpm --filter @lody/site-docs generate`、`typecheck` 和 `test` 通过；
  `pnpm run docs check` 没有新增错误。
- 生产构建会预渲染站点；被删除的页面不再存在，侧边栏分组显示为 Feature List /
  功能列表。
- 全量静态浏览器套件报告 307 个通过用例（删除两个 VS Code 主题页面前为 309 个），以及
  变更前后相同的两个移动端 `no-js navigation` 基线超时；内部链接检查没有发现指向已删除
  页面的链接。
- 中英文一起更新，但未经母语者审阅。
- 删除页面属于 URL 决策。站点没有运行时重定向层，因此 `/docs/vscode-themes/` 和
  `/zh/docs/vscode-themes/` 现在会返回 404；如需重定向，需要单独做兼容性决策。
- IA 记录仍为 `proposed`，并已记录 Feature List 这个名称；未来再改名时需要同时更新
  Spec 和该记录。

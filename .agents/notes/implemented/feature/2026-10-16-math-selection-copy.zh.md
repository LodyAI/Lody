# 将选中的已渲染公式复制为 LaTeX

Status: implemented
Translation: current

[English](2026-10-16-math-selection-copy.md)

## 摘要

此前选中已渲染公式后，复制得到的是排版后的文字，无法直接复用为 LaTeX。共享 Markdown 渲染器现在加载 KaTeX 自带的 Copy-tex 扩展，将剪贴板纯文本中的公式转换为 LaTeX，同时保留选中的 HTML。行内公式和块级公式分别使用 `$...$`、`$$...$$`，只选中公式的一部分也会扩展为完整公式。由于 Copy-tex 不检查 `defaultPrevented`，会话选区保护逻辑会在内容尚未完整加载时同时停止事件传播。合成 DOM 测试验证了转换结果及不完整选区不会写入剪贴板；原生剪贴板和设备验收仍未验证。

## 决策与职责

[共享渲染器](../../../../packages/components/src/components/ai-gui/markdown-renderer.tsx) 通过模块依赖图一次性导入 `katex/contrib/copy-tex`，复用现有 KaTeX 依赖，为静态和流式 Markdown 接入相同能力，无需新增设置、依赖或自定义公式序列化逻辑。扩展处理原生选区复制；消息复制按钮继续使用现有源文本路径。

[原生选区保护](../../../../packages/components/src/hooks/use-conversation-text-selection.ts) 继续负责检查会话选区对应的行是否已挂载并加载完整。对不完整选区，其捕获阶段监听器在 `preventDefault()` 之外增加 `stopImmediatePropagation()`，避免扩展在 document 上的监听器写入缺失内容的剪贴板数据。这延续了[选区保留决策](../bug-fix/2026-09-20-conversation-text-selection.md)的保护职责；选区保留和历史加载的职责不变。行内公式渲染继续遵循[现有偏好设置](2026-09-28-inline-math-preference.md)。

选择官方扩展而不是维护自定义复制处理器，是因为现有 KaTeX 包已经提供源码提取、公式边界扩展以及两种剪贴板格式。仅导入扩展会绕过不完整选区的复制取消，因此阻止后续处理器也是本次接入的一部分。Copy-tex 使用选中片段的 `textContent` 生成纯文本；本次接入不增加 Markdown 序列化，也不保证保留每个可见的块级分隔。

## 验证与限制

- [渲染器测试](../../../../packages/components/tests/markdown-streaming-reparse.test.ts) 使用真实公式 DOM、原生 Range 和派发的复制事件，覆盖公式与正文混选、块级公式、静态与流式路径、部分公式选区、HTML 保留以及普通正文继续走默认复制。
- [选区测试](../../../../packages/components/tests/conversation-text-selection.test.tsx) 加载真实扩展，验证包含公式的选区在中间行尚未完整加载时不写剪贴板，并在该行就绪后复制出 LaTeX。
- 开发检出目录中，七个相关测试集的 114 项测试全部通过，组件类型检查、改动范围内的格式检查及差异空白检查也已通过。改动范围内的类型感知 lint 报告零错误、23 条警告。文档检查仍报告 subagent-events 提案中英双语文件中已有的六条失效链接，没有新增文档错误。这些检查发生在将本次改动迁移到当前 `main` 之前；按用户要求，不再追加本地测试，全仓库检查交由 CI 执行。
- 测试中的剪贴板载荷使用内存实现的 `setData`，不代表已完成操作系统原生剪贴板、Safari 或移动设备验收。

PR: [#1595](https://github.com/LodyAI/Lody/pull/1595)

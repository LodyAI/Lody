# 在销毁 jsdom 前完成 Markdown 模块导入

Status: implemented
Translation: current
PR: [#1879](https://github.com/LodyAI/Lody/pull/1879)

[English](2026-10-25-markdown-test-import-drain.md)

## 摘要

CI 的第三个组件测试分片中，204 个测试文件全部通过，但 KaTeX Copy-tex 在 jsdom 销毁后
访问 `document`，产生了 21 个未处理拒绝。Session 分享 Markdown 测试现在通过 `afterAll`
等待未完成的动态导入。这保留了真实的延迟加载路径，同时让浏览器初始化在测试环境存续期间完成。

## 范围与验证

[Markdown 测试](../../../../packages/components/tests/session-share-markdown.test.tsx)挂载真实
渲染器，其 effect 导入[浏览器专用入口](../../../../packages/components/src/components/ai-gui/markdown-math-copy.ts)。
Copy-tex 在模块求值期间注册 document 监听器，背景见[公式复制决策](../feature/2026-10-16-math-selection-copy.md)。
`vi.dynamicImportSettled()` 在测试组释放 jsdom 前等待这些工作完成，不吞掉导入错误，也不将
扩展替换为 mock。本地 Markdown 渲染、选区和分享三个相关测试组的 93 个测试全部通过。
原始 CI 失败依赖模块加载时序，局部本地基线未复现；仍需 CI 验证运行器上的结果。
本地完整分片未出现未处理的导入错误，但另外八个文件因复用依赖缺少导出或存储 fixture
错误而失败，不能将其视为完整分片通过。

# PR 页签的浏览器夹具等待懒加载完成

Status: implemented
Translation: current
PR: [#1970](https://github.com/LodyAI/Lody/pull/1970)

[English](2026-10-27-pr-tab-lazy-import-lifetime.md)

## 摘要

PR 页签布局测试挂载真实 Markdown 渲染器，会启动仅限浏览器的懒加载。CI 可能在全部断言完成后销毁 document，而 KaTeX copy-tex 尚未求值，随后产生未处理拒绝。测试现在在最终钩子中等待 Vitest 的待完成动态导入，让浏览器夹具活到模块实际完成。产品加载行为和渲染断言保持原样。

## 所有权与证据

`pr-tab-view.test.ts` 拥有其 jsdom document 和挂载产生的导入。卸载 React 不会取消原生模块加载，因此最终清理使用 `vi.dynamicImportSettled()` 等待实际完成，不用睡眠、不模拟 Markdown、不吞错或削弱断言。这补充了[模块图决策](2026-09-10-components-test-module-graph.zh.md)的逐文件所有权。

原 CI 分片的 208 个文件、1927 个断言全部通过，但此夹具销毁后，`katex/contrib/copy-tex` 报出三个 `document is not defined` 拒绝。汇总 Tests 任务只是反映该失败；CLI 与 Fleet 套件均已通过。本地单文件未复现 CI 时序，所以失败证据来自 CI，修复依据是明确的完成边界。受影响分片及后续 CI 提供验证，不代表产品渲染或原生钥匙串验收。

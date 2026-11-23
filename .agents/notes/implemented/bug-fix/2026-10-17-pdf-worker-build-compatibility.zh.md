# PDF Worker 构建兼容性

Status: implemented
Translation: current

[English](2026-10-17-pdf-worker-build-compatibility.md)

## 摘要

PDF.js 的 legacy Worker 仍然调用 Safari 16.4 缺少的 `Promise.withResolvers`。
原先把它作为原始 URL 资源导入，绕过了宿主的 Worker 构建处理，因此主线程的兼容代码
无法保护 PDF 加载。查看器现在使用经过 Vite 构建的项目自有 Worker 入口，同时保留
PDF.js 在无法使用独立 Worker 时所需的导出。产物测试在缺少原生 API 的独立环境中
打开并重新打开 PDF，也验证了主线程回退；这些检查不能替代旧系统真机验收。
关闭一个预览时还会清空其文档并取消生命周期 signal，释放对应的文档、编辑器监听器。
全局文本选择监听器直到最后一个文本层关闭才释放，避免关闭一个 PDF 后破坏其他已打开 PDF。

## 决定与证据

本变更补充[原 PDF 预览决定](../feature/2026-09-29-session-pdf-preview.zh.md)。
查看器、解析器和 Worker 继续统一使用 legacy 入口。legacy 包自带部分新 API 的补丁，
包括 `Promise.try` 和 `URL.parse`，但没有补齐 `Promise.withResolvers` 或 `AbortSignal.any`。

`session-file-pdf.worker.js` 重新导出 `WorkerMessageHandler`，查看器通过
`?worker&url` 导入其 URL，让依赖经过各宿主的 Worker 插件处理。需要运行时兼容的宿主
必须在这条构建路径中安装前置补丁，并确保补丁先于依赖执行。普通 `?url` 只会复制原始
资源，无法提供这个保证。

PDF.js 继续通过原有文档加载任务创建、持有和终止 Worker。不引入共享 `workerPort`，
以免改变销毁和复用行为。它的回退路径会动态导入 Worker URL，再从模块命名空间读取
`WorkerMessageHandler`；因此，即使独立 Worker 通过副作用自动启动，也必须保留导出。

Vite 7 会把 `worker.rollupOptions.preserveEntrySignatures` 强制覆盖为 `false`。
`preservePdfWorkerExports()` 在随后执行的 Rollup options hook 中设为 `strict`，
并且只匹配 PDF 入口。公开 Electron 和 Storybook 已在 Worker 插件链中安装该 helper；
其他使用此查看器的宿主也需要安装。

向 `PDFViewer` 传入组件的生命周期 signal。卸载时先调用 `setDocument(null)`，
再取消这个 signal，最后销毁加载任务。`cleanup()` 只重置尚未完成的页面渲染，
不会取消文档事件 owner，也不会销毁批注编辑器管理器。普通只读 PDF 也会创建该管理器
及其键盘、文本层监听器。清空文档负责释放这些 owner；生命周期 signal 负责释放滚动
监听和 ResizeObserver。同时清空 link service 持有的文档。
这对需要保留 PDF 组合 signal 直到其 owner 取消的兼容实现尤为必要。
PDF.js 6.3.289 自带类型遗漏了构造参数 `abortSignal`，以及 `PDFViewer.setDocument`
允许传入 `null` 的情况。类型扩展只放在当前组件内，与已验证的运行时行为保持一致。

PDF.js 6.3.289 把静态文本选择 controller 和首个查看器的生命周期 signal 组合在一起。
关闭首个查看器时，全局监听被移除，但其他文本层仍在注册表中；非空的静态 controller
又阻止了重新注册。`pdfjs-dist` 的 pnpm patch 让全局监听仅由
`TextLayerBuilder.#selectionChangeAC` 管理：现有逻辑会在最后一个文本层移除时取消并
重置它。查看器和单个文本层的 signal 保持原有归属。legacy 和 modern 查看器入口应用
同样的小补丁。不要通过移除查看器 signal 或把 `setDocument(null)` 改回 `cleanup()`
来绕过这个共享状态问题，那会让其他监听器继续存活。

PR：[#1643](https://github.com/LodyAI/Lody/pull/1643)。

## 验证与限制

- 生产式 Vite Worker 构建曾丢失导出；helper 修复了这一点，包括使用现有
  top-level-await 转换时的产物。
- 构建出的 Worker 在缺少 `Promise.withResolvers` 的独立环境中自动初始化消息端口，
  成功打开并读取一页合成 PDF，两次打开之间完成文档销毁。
- PDF.js 的真实无 Worker 路径也能动态导入构建产物并读取 PDF。
- 当前 WebKit 测试移除较新的原生 API，渲染真实预览组件的文本层，连续打开、关闭两次。
  测试观察 PDF.js 实际生成的组合 signal 以及键盘、文本选择和指针监听器注册；关闭后
  signal 全部取消，绑定它们的原生 DOM 监听器不再响应。仅在测试构建中恢复旧 `cleanup()`
  的对照会留下仍然活跃的文档 signal。
- 确定性的双预览测试依次渲染 A、渲染 B、在 B 中选中文字、关闭 A，再在 B 中选择。
  随后关闭 B 并重新打开 C，检查选择行为和最后的监听器释放。应用依赖补丁之前，
  关闭 A 后，B 无法再进入 `selecting` 状态。
- 原有 PDF 范围读取和解析测试全部通过，共三项。
- 以上属于构建和运行时行为验证，尚不代表 iOS 真机验收。

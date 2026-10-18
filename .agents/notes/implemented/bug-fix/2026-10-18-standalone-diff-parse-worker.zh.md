# 使用共享 Worker 解析单文件 diff

Status: implemented
Translation: current

[English](2026-10-18-standalone-diff-parse-worker.md)

## 摘要

工具消息和 PR 文件的独立 diff，以前在两版合计不足 200,000 字符时同步解析。文本长度无法限制比较复杂度：低于阈值的合成 5,000 行替换会连续占用主线程约 1.74 秒。现在缓存未命中在可用时使用已有共享解析 Worker，同时保留原同步路径提供的完整未修改行上下文及降级可用性。显式多文件／分块源和大文件路径仍限制结果大小，保持原错误行为。移走计算本身不保证 diff 更早就绪，也不解决超大 diff 的 DOM／布局成本。

## 决策与行为

`ui/diff-viewer/diff-viewer.tsx` 扩展已有 Worker 路径，保留队列、完整输入请求身份、解析缓存、过期结果隔离、暂停任务复用及可见性准入。已有 metadata 和缓存命中不重新解析。不增加 Worker owner、数据权威或消息生命周期；React 展示继续使用普通 TypeScript，不迁移既有共享 Worker 请求 owner。

```text
可见内容缓存未命中
  → 已有共享 Worker 队列
  → 比较完整的新旧输入
  → 丢弃过期结果
  → 恢复原同步输入的未修改行上下文
  → 缓存并渲染
```

Worker 为控制多文件结果大小，刻意删除完整新旧行数组。新移出的、低于旧阈值的独立 diff 使用 Pierre 导出的 `SPLIT_WITH_NEWLINES` 重建数组，保留 CRLF、空文件、末尾换行，以及上下文展开／渲染所需的未修改行。仅这些原本同步处理的输入，在 Worker 创建／执行失败时保留同步读取降级；没有 Worker API 时仍走原同步路径。显式 worker-only、分块和更大输入继续报告错误，不进行可能无界的同步重试。已取消或被替换的 effect 不恢复上下文，也不启动降级解析。

只改默认执行位置、却不恢复完整行，会改变单文件上下文行为。让所有 Worker 结果都返回完整文件，又会扩大已有大文件和分块界面的内存／传输成本。因此在 viewer 保留原有区分，共享 client／Worker 协议不变。[多文件决策](2026-10-17-multi-file-diff-opening.zh.md)继续拥有视口／读取上限，本变更不替换它。

## 正确性与测量限制

Owning viewer 套件覆盖显式延迟解析的 loading→ready、包括未修改 CRLF 上下文的完整结果等价、缓存重新挂载、过期文件结果、Worker 缺失／失败、已有 metadata、折叠内容延迟加载、可见性暂停、未发送评论、完整输入编辑和显式 worker-only 错误。既有 client 和真实 Worker 实现套件覆盖分块传输与有界结果。正确性测试不使用墙钟性能阈值。

此前生产浏览器审计中，3,000 行替换的同步解析耗时 610.5–620.3 ms；5,000 行、合计 177,781 字符时为 1,743 ms。后者使用已有 Worker 耗时 1,673 ms，最长帧间隔 6.2 ms；直接／Worker 规范化 metadata 一致。这些测量隔离了解析，不是完整 viewer 绘制或打包 Electron 的性能。Worker 失败时，刻意保留的旧降级仍可能短暂阻塞；超大 diff 也仍可能有 DOM／布局成本。

最终实现通过根 `pnpm check`（包括组件 576 个测试文件／5,609 条测试）与根 `pnpm format`。使用真实 viewer 的隔离生产 Storybook 验证了 120 行 CRLF 上下文可全部展开，包含首尾行。5,000 行／177,781 字符的完整替换正确渲染到最后一条新行，就绪耗时 2,827.7 ms，最长帧间隔 845.7 ms。这个完整 viewer 结果揭示了仍有渲染成本，不能套用仅解析测量的帧间隔结论。验证构建显式保留 Pierre 1.0.10 既有 custom-element 注册，因为上游包的 side-effect 声明指向 source，而非实际发布的 dist；测试环境修正不改变产品源码。`pnpm run docs check` 仅报告 6 个指向未初始化 Kimi/Pi 子模块的现有断链。

[文件界面文档](../../../docs/sessions-file-surfaces.md)和最近 UI 规则记录当前路径。产品回归与根检查结果记录在 PR 中，私人 trace 和会话不进入变更。

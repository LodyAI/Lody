# 在 Worker 中高亮 Markdown 代码

Status: implemented
Translation: current

[English](2026-09-23-markdown-highlight-worker.md)

## 摘要

打开一个自页面加载以来尚未高亮过代码块的会话时，Shiki 会在主线程同步分词：一次标签切换的 Chrome
trace 显示，切换提交后紧跟一个 141ms 的任务，其中 83ms 是 `codeToTokens`。现在 markdown 代码插件把
未命中缓存的代码块发给模块 Worker，并通过 Streamdown 已有的异步回调交付结果；缓存命中仍然同步返回。
没有 Worker 的构建回退到同一个主线程高亮器。真实切换中的效果尚未重新测量。

## 决策

- `lib/markdown-highlighter.ts` 统一管理高亮器配置（语言、CSS 变量主题、JavaScript 正则引擎），
  Worker 与回退路径共用，保证分词结果一致。
- `lib/markdown-highlight-client.ts` 让相同的进行中请求共享一次往返；单次分词失败只拒绝该请求，
  不停用 Worker；Worker 崩溃后拒绝所有待处理请求并标记为不可用，插件随后改在主线程高亮，不再重试 Worker。
- `lib/markdown-highlight-worker.ts` 用 `new Worker(new URL(…), { type: 'module' })` 按需创建
  Worker；没有 `Worker`（单元测试、服务端渲染）时返回 null。site-docs 营销构建保留 Vite 默认的 `iife`
  Worker 格式，无法拆分 Shiki，因此像 diff 渲染 Worker 一样把该模块别名到返回 null 的替身。
- Streamdown 在回调到达前渲染原始代码，且不取消请求；Worker 按到达顺序处理，同一代码块的各版本按
  请求顺序返回。

较小的替代方案是把主线程高亮推迟到空闲任务，但时间仍花在主线程上，大代码块仍是一个长任务。

## 限制

如果同一代码块旧版本的请求尚未返回、新版本命中了缓存，迟到的旧结果可能覆盖它；原有的懒加载路径
也有同样的竞态。Worker 会加载自己的一份 Shiki 语法。验证：客户端单元测试、组件测试集、生产 web
与 site-docs 构建；尚无新的 trace。相关：[弹层重算](../bug-fix/2026-09-23-portal-full-restyle.zh.md)。

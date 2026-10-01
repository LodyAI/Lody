# Prompt Shortcut 正文预取

Status: draft
Translation: current

[English](prompt-shortcut-body-prefetch.md)

当工作区目录展示一条 Prompt Shortcut 时，调用它通常不应再等待 Prompt 正文下载。工作区 runtime 与可读目录就绪后，客户端会在空闲窗口中安排当前可见正文的后台加载。目录发现仍然只依赖 index，不等待正文加载。

Runtime 会跨目录更新串行处理后台正文加载。前台调用不会排在无关预取任务之后；如果它请求的正是正在加载的同一 index 正文，则复用该请求。成功取得的正文继续写入现有按账号和工作区隔离的持久化 Shortcut 存储，后续调用可以使用本地副本。

预取是尽力而为的。失败不会隐藏 index 条目，也不会展示成一次调用错误；后续目录发布或恢复在线时可以重试。范围变化会停止排队中的工作。每个后台读取都执行与前台读取相同的目录授权和精确 index/body revision 校验，包括同步后的再次校验；预取不会授予访问权限，也不会让过期条目变得可调用。

正文保留沿用现有 Prompt Shortcut 数据存储的生命周期。本行为不会引入第二份缓存，也不新增删除保证。未来仍可考虑把可回收的远端副本与离线创作数据拆开存储。

## 证据

- 调度与工作区生命周期：`packages/components/src/providers/prompt-shortcut-provider.tsx`。
- 授权、串行化与请求合并：`packages/shared/src/prompt-shortcuts/runtime.ts`。
- 本地持久化：`packages/shared/src/prompt-shortcuts/local-store.ts` 与 `sync.ts`。
- 行为覆盖：`packages/shared/tests/prompt-shortcut-runtime.test.ts` 与 `packages/components/tests/prompt-shortcut-provider.test.tsx`。

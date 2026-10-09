# 空闲时预取 Prompt Shortcut 正文

Status: implemented
Translation: current

[English](2026-09-29-prompt-shortcut-body-prefetch.md)

## 摘要

Prompt Shortcut 的发现流程有意只携带小型 index，因此首次调用尚未缓存的 Shortcut 时，过去需要等待完整 Prompt 与 mention ranges 下载。现在工作区 Provider 会在空闲窗口安排可见正文的预取，同时 runtime 会串行处理所有预取批次，并让匹配的前台读取复用同一请求。下载的正文继续使用现有按账号和工作区隔离的持久化存储，在不改变授权的前提下改善后续调用和离线调用。远端正文副本仍与离线创作数据共用数据库，因此回收过期版本仍是独立的后续工作。

## 决策

Index 继续排除 Prompt 与 mention ranges。如果把正文放进每次目录同步，发现延迟与带宽会随 Prompt 大小增长，即使客户端在当前范围内无法使用某条记录也要承担这项成本。

Provider 只会在出现可见 runtime snapshot 且浏览器进入空闲窗口后启动预取。网络基数由 runtime 而不是 React 管理：它跨 snapshot 更新串行处理批次、忽略已经不是当前版本的条目，并在 runtime 生命周期内记住已成功加载的正文。前台读取不进入后台队列，但会复用相同的进行中读取。后台失败保持静默并可重试；如果用户选择时正文仍不可用，普通选择路径仍会给出可操作的错误。

复用现有读取路径可以保留同步前后的目录校验，以及精确的 index/body revision 校验。它也复用现有基于 IndexedDB 的 Loro repository，不增加内存缓存或第二份持久缓存。代价是：预取会扩大当前远端正文落地的范围，而普通“清缓存”会保护这个数据库，因为其中可能保存离线编辑的唯一副本。可回收的远端副本存储或明确的正文垃圾回收需要独立的存储决策和迁移证据。

考虑过的替代方案包括：随 index 一起获取正文，但这会阻塞轻量发现；只在命令菜单打开后预取，但这仍保留首次使用延迟，离线效果也更弱。没有采用无界并行预取，因为每次未命中都会获取一个限定范围的 Streams room，而目录刷新可能彼此重叠。

产品行为记录在[正文预取规格](../../../../specs/prompt-shortcut-body-prefetch.zh.md)中。本决策补充了[正式发布决策](2026-09-29-prompt-shortcuts-general-availability.zh.md)，并保留 [runtime 退役保证](../bug-fix/2026-09-25-prompt-shortcut-runtime-lifecycle.zh.md)。

## 验证

Runtime 测试覆盖前台/后台请求合并、串行加载、失败后继续、重试、重叠批次与取消排队工作；Provider 测试验证空闲回调之前不会启动正文工作。两个针对性套件共九项测试通过。初始化固定版本的 ACP submodules 后，全仓 type check 与 lint、两个受影响包的 type check、i18n 检查和边界检查均通过。

完整 `pnpm check` 的测试阶段没有在沙箱中跑完，因为继承的 Git 配置要求 fixture commit 使用 GPG 签名；对该进程关闭签名后，受影响的 50 项 Code Collab 测试全部通过。`pnpm run docs check` 能识别两组新增的双语文件，且没有新增文档错误，但仍被仓库中既有、无关的断链阻断。

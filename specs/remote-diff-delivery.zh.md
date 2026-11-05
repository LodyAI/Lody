# 远程 diff 传输

Status: draft
Translation: current

[English](remote-diff-delivery.md)

成员查看另一台机器的 diff 时，只应接收所打开文件需要的内容，并复用未变化的内容。
文件所属 daemon 仍须在线；渲染器缓存不构成离线 diff 服务。

声明 `codeCollabDiffBlobs` v1 的机器提供 owner 范围内的分页清单和原始字节范围读取。
每次读取都重新校验会话既有的 diff 权限；知道内容哈希并不授予权限。
Git 基线、保留中的 turn 证据和实时磁盘是不同来源。历史 turn 不得替换成当前磁盘内容，
来源过期必须明确失败。原始字节必须先通过内容键校验，再解码或缓存，校验包含 BOM 和换行字节。

这两个 handler 不启动文件监听、不修改证据。加密调用维持既有 writer 权限与执行 claim。
Guest diff 功能拆到后续独立 PR；本次传输变更不向只读成员授予 Git 基线或历史证据访问权。共享文件索引仅携带不透明的逐路径失效 token，不携带能够确认猜测文件内容
是否存在的哈希。只读证据访问仅打开已有且结构已识别的数据库，不初始化、不迁移、不执行 GC。

只有普通远程工作区允许将已校验的 blob 持久化到渲染器中有界、可重建的 IndexedDB 缓存。
本地与加密工作区的 blob 缓存仅保存在有界内存中；工作区释放或内容准入被撤回时清理。
缓存命中不证明当前权限或文件新鲜度；实时界面仍须具有内容准入和当前清单标识。

远程响应受编码后的分页预算约束。大文件可先显示部分 patch，用户展开上下文时再读取完整且
校验通过的文件。patch 超过计算或传输预算时回退完整 blob；只有原始正文超过大小上限
才成为明确的不可用或统计条目。非普通文件按单文件显示 binary，操作性错误不得隐藏其他文件。
延后加载上下文时内容标识变化，应刷新完整比较及其基线标题；展开失败提供重试。旧机器和旧客户端继续使用现有
diff 接口；支持能力通过 capability 协商，不根据 CLI 版本推测。

缓存落盘策略和增量 v1 兼容性约定是需要人工审阅的决策。本草案记录已实现的
意图，不代表已经批准。

证据：[决策与验证](../.agents/notes/implemented/architecture/2026-10-31-remote-diff-transport.zh.md)、
[协议 schema](../packages/shared/src/code-collab-diff.ts)、
[daemon](../apps/cli/src/lib/code-collab/code-collab-v2-service.ts)、
[客户端](../packages/components/src/lib/code-collab-session-file-provider.ts)。

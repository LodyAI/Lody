# 普通聊天冷恢复后文件预览丢失工作区

Status: implemented
Translation: current

[English](2026-10-09-cold-chat-file-preview-workspace.md)

## 摘要

普通聊天的运行时 Session 存在时可以预览产物，实例消失后却可能拒绝同一个文件。
预览工作区解析器能从元数据重建本地项目和 GitHub 工作区，但遗漏了默认聊天目录。
隔离执行实际解析方法，已在合成文件仍可从磁盘读取的条件下复现原报错。
解析器现在只读重建聊天所属会话的已有目录，不启动 Agent 或创建目录。尚未确认用户
此次故障具体由哪一种事件触发；实现覆盖运行时实例不再驻留的情况。

## 证据

- [session.ts](../../../../apps/cli/src/session/session.ts) 的 `Session.getWorkdir()`
  为普通聊天调用 `ensureDefaultSessionWorkdir(sessionId)`，目录为
  `<getLodyDataDir()>/chats/<sessionId>`，并非没有工作区。
- [MessageHandler](../../../../apps/cli/src/lib/message-handler.ts) 将 `file/preview`
  和本地 `file/resolve-local` 接入同一个工作区解析器。
  修复前，`resolveCodeCollabWorkspaceRoot` 优先读取 active 或 pending Session 的主机目录；
  实例不存在时，元数据分支只处理本地项目、仍在运行的父会话和 GitHub worktree，
  随后返回原文 `Session has no local project or GitHub repository workspace.`。
- [FilePreviewService](../../../../apps/cli/src/lib/file-preview/file-preview-service.ts)
  在解析请求路径、读取文件之前就返回工作区错误，因此绝对路径也无法绕过此故障。
- [GC](../../../../apps/cli/src/lib/session-gc-manager.ts) 默认闲置超时为 20 分钟，
  回收前检查会话是否符合条件，也支持内存压力回收。`cleanSessionForGC` 终止运行时、
  卸载临时状态；`SessionManager` 从内存映射中移除退出或终止的实例。主机端重启也会
  清空该映射。这些是可能的触发条件，不能据此判定此次发生了哪一种；也未证明仅仅
  重新打开界面就会终止运行时。
- [前端工作区推导](../../../../packages/components/src/lib/session-workspace-path.ts)
  已支持聊天目录；[终端解析器](../../../../apps/cli/src/lib/terminal-workdir-resolver.ts)
  也支持冷聊天，但它会创建目录，因此不能直接作为只读预览解析器使用。

该问题与此前的[前端路由与缓存修复](../../implemented/bug-fix/2026-09-29-local-file-preview-route-cache.zh.md)
及[主目录路径处理](../../implemented/bug-fix/2026-10-08-home-rooted-file-link-paths.zh.md)不同。

## 修正

共享工作区解析器现在将只有持久元数据的普通聊天解析为
`getDefaultSessionWorkdir(parentSessionId ?? sessionId)`，并要求目录已经存在。
冷聊天所属会话的元数据必须有效：缺失、删除、归档、主机不匹配、绑定项目或 worktree、
以及嵌套父会话都不能获得聊天目录回退。本地项目和 GitHub 保留原有解析分支与失败语义。
`file/preview` 和 `file/resolve-local` 均得到修复，显式 Code Collab 请求也与聊天
运行时仍驻留时保持一致。目录解析本身不会激活 Code Collab、发布 Flock 状态或恢复
Agent。没有直接复用终端解析器，因为它会创建目录。

## 验证与限制

首先用合成依赖隔离执行实际解析器：Session 驻留时可以读取产物，只移除实例后就出现
原报错，文件内容仍在磁盘上；冷子会话也失败。新增 Machine RPC 集成测试对临时文件
运行真实 MessageHandler 与 FilePreviewService，覆盖热转冷后的相对/绝对路径读取、
本地文件身份、子会话归属和归属不匹配、目录或文件缺失、会话及父会话元数据无效、
父工作区无法解析等情况。测试依赖禁止创建 Agent、修改文档和访问 Code Collab，
成功读取因而必须走只读路径。临时测试数据不包含用户内容。

新增集成套件在基线代码上九项中六项失败，修复后九项全部通过。连同现有文件预览
套件，共 50 项通过，三项因文件系统特性跳过。
`pnpm format`、`pnpm run docs check` 和完整 `pnpm check` 均通过。完整检查仅为
测试子进程移除了外层 Agent 会话的 Git 包装器及继承的 `GIT_*`/`LODY_GIT_*`
变量：原环境首次运行会使无关的原生 Git 凭据测试报 `context_unreadable`。CLI
3522 项通过、四项跳过，components 4888 项通过，shared 1295 项通过。文档只保留
现存警告。没有运行完整 Electron 界面，也没有检验用户特定产物。

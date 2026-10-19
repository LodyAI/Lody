# 共享命令的工作区管理器

Status: implemented
Translation: current

[English](2026-10-14-workspace-presence-manager-collision.md)

> 后续变更：[由 daemon 执行 MCP 工作区命令](../architecture/2026-10-16-daemon-hosted-mcp-workspace-commands.zh.md) 让 Cloud MCP 命令改用 daemon 副本，并移除下文所述的 presence 未释放栅栏。

## 摘要

重叠的 Cloud 命令共享一个文档管理器，避免重复申请 presence，并保留身份隔离和最后使用者清理。修复只在命令组合入口，presence、token 和撤权均不改变。

## 原因与范围

并发 Cloud MCP 请求在同一应用里创建各自的临时 `LoroDocumentManager`。presence 注册表只允许一个工作区实例，即使第一个实例正常，也拒绝第二次申请。Legacy 错误随后被标成 `INTERNAL_ERROR`、`retryable:false`，发生在 `Operation.accept` 和目标输入写入前。`e0ad6d4870be2ccd409e45462c713f03ef5feb4e` 引入独占注册表，`2263513f1841a9bf7d79530d977fbd55e7fda20c` 把产品管理器接入它。

修复共享命令已有的文档管理器，避免引入通用 presence/token 使用权框架。Discovery/MCP helper 和 `commands/session.ts` 统一走 `command-runtime.ts` 的入口。daemon 提供的 Session 命令环境继续借用已有管理器。

```text
并发命令 → 一个文档管理器 → 已有 presence / 连接 / token
一个回调结束 → 其余回调继续使用
最后一个回调结束 → 等待管理器原有清理
```

## 生命周期约定

- 触发与归属：`workspace-command-manager.ts` 在 Cloud 命令回调重叠期间，为每个工作区保留一份正在创建或已创建的管理器。同用户、精确 token、机器和配置的认证地址才能共用；不同身份会失败，不暴露凭据。身份字段复制保存，清理成功后移除。
- 取消：每个回调持有使用权，直到自己的 Promise 真正结束。一个命令结束不能关闭别人还在使用的管理器；回调不能自行调用管理器清理。
- 交接：最后清理期间来的命令等待实际完成结果，其他工作区可独立运行。没有闲置缓存、定时器、新执行 runtime 或新连接/token 所有者。
- 失败：创建失败会传给全部等待者，之后允许新尝试。最后清理失败沿用原有日志策略，不撤回已接收的命令结果。仅当 presence 尚未释放时，保留原管理器和失败结果并阻止替换。presence 真正释放后，transport/session/repo 错误会记录并移除条目；已等待和后续命令均可创建新管理器。`isPresenceReleased()` 通过 Legacy 入口读取原生实例状态，不按错误类型猜测，因为后面的析构错误可能掩盖 presence stop 失败。文档和应用已有的清理机制继续保留原生资源；没有增加运行中恢复 API 或统一放宽重试。

这层协调明确仍属 Legacy：文档创建、命令回调和文档清理依赖 Promise 工作流，迁移这些依赖不在本次范围内。presence、token provider、platform port 和机器撤权均未改变。直接构造两个同工作区管理器仍不支持，Cloud 命令入口现在会避免这样做。

## 验证

命令测试覆盖并发等待创建、存活回调写入、最后释放、清理交接、不同工作区互不阻塞、身份隔离、创建/回调失败，以及清理失败阻止替换。文档管理器回归调用真实命令入口和原生 presence 注册表，repo/transport 使用合成端口，证明两个命令能进入且存活命令仍能写入。准备和释放使用显式 Promise 信号，不依赖 sleep 或外部网络。

独立 checkout 使用冻结依赖，改动源码字节一致。运行中的打包应用、用户会话和网络配置均未改；源码检查不代表打包应用或远端送达验收。

并发回归在未改的 `08a58d6f3bcd4d0dc7287d6462548b83113a0cf2` 上产生原错误 `Workspace presence operation failed`，共享命令入口上通过。两个相关套件和原生 presence 套件共 76 项全部通过。保留只读释放状态入口、还原 `d9f430518` 的旧共享池，复现两条清理后失败：`removeTransport` 和 repo 析构错误在 presence 已确认释放后仍阻止下一条命令。修复后两者和已经等待的调用者均能替换管理器，presence 未释放时仍阻止替换。独立 checkout 的完整 `pnpm check`、`pnpm format`、`pnpm format:check` 和 `pnpm run docs check` 均通过；使用系统 Git 隔离会话包装器影响。真实 agent E2E 和可选 macOS host-key 测试未启用；打包应用尚未验收。

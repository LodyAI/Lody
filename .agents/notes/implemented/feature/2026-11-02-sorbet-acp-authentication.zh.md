# Sorbet 认证与本地控制

Status: implemented
Translation: current

[English](2026-11-02-sorbet-acp-authentication.md)

## 摘要

内置 Sorbet 直接使用 `@sorbetai/control` 完成交互式登录、凭据元数据、自定义 Provider 管理、模型刷新与模型目录读取。提示与进度仍复用现有受保护的 Machine RPC 或签名 E2EE owned execution 边界，秘密始终留在目标机器。共享数据目录的锁、原子替换、迁移和引用检查由 Sorbet 负责；Lody 只提供目录，不解析其中的文件。

## 决策与证据

Sorbet 登录调用 `control.authentication.methods()` 与 `control.authentication.login()`，不再启动 ACP 进程。现有 Machine RPC 交互流承载文本、秘密、单选提示与授权进度。远程回复加密给目标机器并绑定请求与交互；秘密默认值不会进入保留进度。行为测试覆盖协商、表单回复和拒绝过期交互。任意表单与终端认证方法仍不受支持。

凭据描述、登出、自定义 Provider 操作、Provider 刷新与可用模型读取直接使用公开的 `@sorbetai/control` package。每次操作都为 `<LodyDataDir>/sorbet` 打开 control、执行请求并关闭 handle。Lody 保留现有 Machine RPC `configId` 校验和 E2EE 授权，但不在内部再复制一套 control 接口，也不再为这些管理调用启动临时 ACP 进程。

`credentials.list()` 只返回 Provider ID 与凭据类型。登录持久化和登出都在 Sorbet 内部完成，因此原始 API key 与 OAuth 凭据不会跨越 Host 边界。自定义 Provider 的创建、列举和删除使用 Sorbet 的标准 store 与引用检查，而不是读取或改写 `providers.json`。

`@sorbetai/acp` 与 `@sorbetai/control` 都跟踪 npm `alpha` 标签。lockfile 记录本次解析的构建，后续安装可跟随各自获准的 alpha channel。control package 会带入同次发布的 runtime packages；这些 package 从仓库的最低发布时间隔离中排除，使刚发布且已获准的 control 构建能够作为一组兼容版本解析。

Sorbet 状态目录继续归 Sorbet 所有。Lody 向 ACP 和 control 传入同一个 `<LodyDataDir>/sorbet` 路径；格式、跨进程 mutation lease、原子性、迁移与清理由 Sorbet 负责。Lody 不解析、导出、预览这些文件，也不声称数据重置会覆盖它们。

## 后果

Sorbet 认证和管理都不再承担 ACP 进程启动、初始化、超时与清理成本。其他 ACP Agent 继续使用各自的协议认证路径。运行中的 Node Agent 可能保留旧的内存 Provider registry，直到重启或 Host 重新组合；Sorbet 也明确记录了 Provider 引用检查与变更之间仍有跨进程 TOCTOU。Lody 不增加一把无法真正关闭该缺口的平行锁。

## 验证

[`apps/cli/src/lib/sorbet-credentials.test.ts`](../../../../apps/cli/src/lib/sorbet-credentials.test.ts)验证可信的本地 Sorbet 身份校验、直接 control 调用、Provider 操作，以及成功或失败后的 handle 关闭。ACP 认证覆盖仍位于 [`apps/cli/src/agent/acp-authentication.test.ts`](../../../../apps/cli/src/agent/acp-authentication.test.ts)。这些测试不覆盖真实 OAuth 行为或运行中 Agent catalog 的重新组合。

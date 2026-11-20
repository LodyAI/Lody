# Sorbet 认证与本地控制

Status: implemented
Translation: current

[English](2026-11-02-sorbet-acp-authentication.md)

## 摘要

内置 Sorbet 使用其公布的 ACP 认证方法完成交互式登录；凭据元数据和自定义 Provider 管理则由 daemon 直接调用 `@sorbetai/control`。两条路径都把秘密留在目标机器，并复用现有受保护的 Machine RPC 或签名 E2EE owned execution 边界。共享数据目录的锁、原子替换、迁移和引用检查由 Sorbet 负责；Lody 只提供目录，不解析其中的文件。

## 决策与证据

Sorbet 登录沿用现有 ACP 认证生命周期，而不是增加服务商专用登录命令。连接声明凭据表单版本 1，支持文本、秘密和单选字段。远程回复加密给目标机器并绑定请求与交互；秘密默认值不会进入保留进度。行为测试覆盖协商、表单回复和拒绝过期交互。任意表单与终端认证方法仍不受支持。

凭据描述、登出和自定义 Provider 操作直接使用公开的 `@sorbetai/control` package。每次操作都为 `<LodyDataDir>/sorbet` 打开 control、执行请求并关闭 handle。Lody 保留现有 Machine RPC `configId` 校验和 E2EE 授权，但不在内部再复制一套 control 接口，也不再为这些管理调用启动临时 ACP 进程。

`credentials.list()` 只返回 Provider ID 与凭据类型。登录持久化和登出都在 Sorbet 内部完成，因此原始 API key 与 OAuth 凭据不会跨越 Host 边界。自定义 Provider 的创建、列举和删除使用 Sorbet 的标准 store 与引用检查，而不是读取或改写 `providers.json`。

`@sorbetai/acp` 与 `@sorbetai/control` 都跟踪 npm `alpha` 标签。lockfile 记录本次解析的构建，后续安装可跟随各自获准的 alpha channel。control package 会带入同次发布的 runtime packages；这些 package 从仓库的最低发布时间隔离中排除，使刚发布且已获准的 control 构建能够作为一组兼容版本解析。

Sorbet 状态目录继续归 Sorbet 所有。Lody 向 ACP 和 control 传入同一个 `<LodyDataDir>/sorbet` 路径；格式、跨进程 mutation lease、原子性、迁移与清理由 Sorbet 负责。Lody 不解析、导出、预览这些文件，也不声称数据重置会覆盖它们。

## 后果

交互式认证继续使用 ACP，因为这是 Agent 公布的认证契约。账户与 Provider 管理不再承担进程启动、初始化、超时与清理成本。运行中的 Node Agent 可能保留旧的内存 Provider registry，直到重启或 Host 重新组合；Sorbet 也明确记录了 Provider 引用检查与变更之间仍有跨进程 TOCTOU。Lody 不增加一把无法真正关闭该缺口的平行锁。

## 验证

[`apps/cli/src/lib/sorbet-credentials.test.ts`](../../../../apps/cli/src/lib/sorbet-credentials.test.ts)验证可信的本地 Sorbet 身份校验、直接 control 调用、Provider 操作，以及成功或失败后的 handle 关闭。ACP 认证覆盖仍位于 [`apps/cli/src/agent/acp-authentication.test.ts`](../../../../apps/cli/src/agent/acp-authentication.test.ts)。这些测试不覆盖真实 OAuth 行为或运行中 Agent catalog 的重新组合。

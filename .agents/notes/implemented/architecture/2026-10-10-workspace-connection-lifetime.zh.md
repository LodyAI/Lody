# 工作区连接的生命周期

Status: implemented
Translation: current

[English](2026-10-10-workspace-connection-lifetime.md)

## 摘要

连接启动失败可能留下已创建的 Repo 和监听器，关闭时也可能先销毁仍被旧 Web attach 使用的 Repo。现在先建立清理路径再启动连接，失败使用同一路径。关闭会取消 token HTTP、永久关闭现有 Effect 重连循环，等待 attach 和 Meta 获取结束后才销毁 Repo。普通存储和 Streams 协议保持不变，本改动不启用 E2EE。

## 归属与选择

基线为公共 main `249661be340af5a20b8d0b7334d2e923fe5b5a99`，包含 [#1399](https://github.com/LodyAI/Lody/pull/1399)。依赖不变：Effect 4.0.2、loro-repo 0.21.2、Streams CRDT 0.16.2、client 0.9.0、Loro 1.16.3、Flock WASM 0.4.3。

- RuntimeProvider 立即停用旧 UI 回调，并取消尚未发布的启动。沿用原关闭等待链，清理完成后才打开下一个 runtime。
- Runtime 负责取消 token HTTP，并保留所有代次的 Web attach 到结束。停用后的 provider 不能发布网关或 RPC client；晚到 Meta 获取只释放自己的借用。原有代次检查仍允许新 token 接管，无需等待旧的不可取消 attach。
- 重连循环沿用 Effect 时钟和重试策略。`stop()` 暂停；`close()` 禁止重新启动，并等待当前重连和计时 fiber。没有另建 ManagedRuntime 或通用任务框架。
- Repo 独占本地持久数据。store 和 transport 保留原清理方式，连接工作结束后才最终销毁 Repo。

```text
停用 runtime
  取消 token HTTP，关闭重连循环
  关闭发送资源、store、订阅和 transport
  等待所有 attach 代次、Meta 获取和重连结束
  沿用原持久化路径销毁 Repo
```

本决定补充 [Effect 基础迁移](2026-10-09-effect-v4-migration.zh.md)和 [Streams 接口](2026-10-10-workspace-streams-content.zh.md)，不全面改写 runtime。不可取消的 SDK 操作仍须结束：不新增关闭期限，也不在超时后销毁仍被使用的 Repo。内存中暂存发送沿用原策略；持久化证据覆盖已经 commit 的 CRDT 修改。

## 证据与限制

生命周期、provider、重连和 Streams 工厂测试覆盖：本地 attach 失败清理、真实 token provider 的 HTTP 取消、晚到 auth/attach/Meta、重复关闭、账号切换和原换 token／重试行为。使用真实 loro-repo、IndexedDBStorageAdaptor 和 fake-indexeddb，验证离线本地 commit 在关闭后重新打开仍在；关闭前没有手动 flush 或远端确认。

[契约](../../../../specs/workspace-runtime-lifecycle.zh.md)为 draft。stream ID、存储名称、快照、游标代码和依赖版本不变。本次没有密钥、持久模式字段、密码学、平台密钥存储、部署或全平台安装包验收。选定连接资源之外的 Promise 工作流仍是后续工作。

本地验证：四组聚焦测试 89 项通过；组件整包 556 个文件、5042 项通过。全仓类型、lint、边界、格式和文档检查通过。`pnpm check` 在两个未修改的 shared IPC 测试中被沙箱 `listen EPERM` 中断；沙箱外重跑 14 项通过。其余包另行补验。CLI 有 3707 项通过及 1 项 Git helper 环境失败；仅让该测试进程使用系统 Git、去掉继承的 `GIT_EXEC_PATH` 后，所属文件 6 项通过。Electron 215 项、UI 299 项、turn-diff-store 31 项通过。这是环境失败后的分项验证，不是一次完整成功的 `pnpm check`。

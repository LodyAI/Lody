# 基于 drive9 的 Lody Memory：以文件存放私有与共享记忆

Status: proposed
Translation: current

[English](2026-11-09-lody-memory-drive9.md)

## 摘要

未发布的 Loro 版 Lody Memory 把每个记忆存为 CRDT 文档。用户无法用普通工具打开、索引或搜索它，个人 E2EE 也阻碍了跨设备使用。
本提案改为把每个记忆存成 Markdown 文件，放在托管的 [drive9](https://drive9.ai/) 文件服务中。
记忆分为**私有**和**共享**两种：私有记忆只经 daemon 的 SDK 访问；共享记忆以读写方式挂载到工作区成员的设备上。可见性在创建后仍可修改。
代价是：记忆内容在托管服务上为明文，记忆只能在线使用，OSS 桌面版没有 Lody Memory。
以上均尚未验证，实施前须先通过 [P1 验证](#p1-实施前验证)。

## 决策

所有者已决定：

- **不做向后兼容。** Loro 版记忆从未发布，不迁移数据，[Loro 设计](../../rejected/architecture/2026-10-26-builtin-personal-memory.zh.md)已否决。
- **记忆不做 E2EE。** 私有和共享记忆都接受在托管服务上以明文存放，以访问控制代替加密保密。
- **共享即工作区成员。** 工作区所有成员都获得读写权限，首版不提供只读成员。
- **drive9 tenant 由 Lody 托管。**
- **接受仅在线可用。**
- **必须记录来源。**
- **可见性可修改**，作为目录元数据保存。

## 布局与身份

每个工作区对应一个 drive9 tenant，每个记忆对应一个目录：

```text
/memories/<memoryId>/MEMORY.md       # front matter：name、description；简短入口
/memories/<memoryId>/<topic>.md      # 其他文档，相对路径
```

路径中不含可见性，因此切换可见性不需要移动文件。
与 Loro 设计一样，路径就是文档身份：改名即移动文件，不会隐式覆盖已存在的目标。
搜索使用记忆前缀下的 drive9 `grep`/`find`，不在进程内扫描。

## 访问路径

```text
             ┌──────────────── 托管凭据服务 ────────────────┐
             │ 目录（memoryId、可见性、所有者）、成员关系   │
             │ 持有 tenant owner key；签发限定范围的 token  │
             └───────┬──────────────────────────┬──────────┘
          限定范围 token（记忆前缀）    限定范围 token（记忆前缀）
                     │                          │
   daemon SDK 客户端（私有 + 共享）    drive9 挂载（仅共享）
   MCP 工具、提示注入、RPC             ~/Lody/Memory/<name>、编辑器、agent
```

- **私有记忆。** 只有所有者的 daemon 通过 drive9 JS SDK 读写。SDK 依赖 Node `fs`，所以只能在 CLI daemon 中运行。Renderer、Web 和移动端都通过 daemon RPC 访问。私有记忆从不挂载。
- **共享记忆。** 走同样的 SDK 路径，另外挂载到 `~/Lody/Memory/<name>`。macOS 和 Windows 上用 WebDAV，Linux 上用 FUSE，由 drive9 的自动模式选择。之后任何成员的工具、编辑器和 agent 都能用普通文件操作访问。
- **Role 绑定。** Role 仍绑定 `{providerId: "lody", memoryId}`，并在每个 turn 中冻结。MCP 工具只拿到所绑定记忆的 token。挂载不受 Role 授权约束，以该用户身份运行的任何程序都能读取，因此只有共享记忆才挂载。

## 凭据

托管凭据服务持有每个 tenant 的 owner key，签发限定路径前缀的短期 token（`POST /v1/tokens`，`{prefix, ops}`）。token 按记忆、按用户签发，可以撤销。

- daemon 只在内存中保存 token，并通过环境变量（`DRIVE9_VAULT_TOKEN`）把 token 传给挂载。
- token 从不写入 `~/.drive9/config`。
- 共享记忆的成员获得 `read, list, search, write, delete`。

在本仓库中，该服务是注入的 `packages/platform` 云端端口，DTO 放在 `packages/cloud-api`。
OSS 桌面版只在本地运行，不发起需认证的产品云请求，因此没有 Lody Memory。是否支持用户自备或自托管的 drive9 端点，仍是未决问题。

## 修改可见性

- **私有 → 共享。** 为成员签发 token，然后在成员设备上挂载。
- **共享 → 私有。** 撤销成员 token，再通知在线 daemon 卸载。其他成员已读过或已缓存在磁盘上的副本无法收回，界面须在确认前说明这一点。

## 来源与并发

- **SDK 写入。** 每次写入都设置 actor 并携带 `expectedRevision`。版本冲突作为冲突返回给 agent，不盲目重试。每次写入成功后，向 drive9 journal 追加一条记录：`{path, changeId, actor, userId, sessionId, turnId, before/after revision}`。
- **挂载写入。** 挂载使用 actor `lody:<userId>:<machineId>`。daemon 通过 SSE 事件流观察并记录这些写入，可归属到用户和机器，但无法归属到 turn。
- **挂载并发写入。** 后写者胜，可借助 journal 恢复。
- **历史。** drive9 没有逐文件版本历史，因此 journal 及其中保存的内容或版本引用就是历史。

## 备选方案

- **保留 Loro 并加 E2EE 同步。** 否决。记忆对普通工具仍不透明，搜索仍在进程内进行，发布还要等个人 E2EE。
- **所有记忆都挂载，包括私有记忆。** 否决。挂载绕过 Role 绑定，会把私有记忆暴露给该设备上的所有进程。
- **在路径中编码可见性**（`/private/…`、`/shared/…`）。否决。修改可见性会变成移动文件，破坏已打开的句柄和挂载。
- **每个用户一个 tenant。** 否决。共享记忆需要跨 tenant 共享，而 drive9 V1 只支持快照复制。

## 影响

- `packages/memory` 中 Loro 专属的代码将被替换：
  - 文档布局、历史和 JSONPath 搜索；
  - SQLite/IndexedDB 持久化；
  - Renderer 副本及其本地数据通道。
- `packages/memory` 保留现有合同，置于 `MemoryBackend` 接口之后，并提供 drive9 实现。
- daemon 声明 `builtinMemory: 2`。客户端拒绝 `1`，确保 Loro 版 daemon 不会承接新合同。
- Lody 把 drive9 CLI 打包为托管运行时，并负责挂载生命周期。
- 托管成本和配额按 tenant（即按工作区）计算，发布前须确定上限。

## P1 实施前验证

1. **SSE 范围。** 限定前缀的 token 订阅 `/v1/events` 时，能否排除其他路径的事件？若不能，daemon 须用单独的凭据监听事件。这是最大的风险。
2. **token 续期。** 运行中的挂载如何在不重新挂载、不丢失写入的情况下换用续期后的 token？
3. **macOS WebDAV。** 在已挂载的记忆上，延迟和编辑器行为（原子保存、临时文件）如何？
4. **搜索与并发。** `grep` 对 Markdown 的召回率如何？SDK 与挂载之间的 `expectedRevision` 冲突是否符合预期？
5. **托管。** 新工作区的单 tenant 成本、配额和开通延迟如何？

待定问题：以后是否为成员提供只读角色？当前决定是所有成员均为读写。

## 验证

尚未验证任何内容。上文关于 drive9 的事实来自阅读 `mem9-ai/drive9` 源码，commit 为 `b866b426`（2026-11-07）：

- `cmd/drive9/cli/mount_webdav.go`（`ResolveMountMode`）；
- `pkg/server/tokens.go`（限定范围的 token）；
- `pkg/server/auth.go`（journal 权限）；
- `clients/drive9-js/src/client.ts`（`expectedRevision`、`setActor`、`watchEvents`、`grep`）。

[记忆 Spec](../../../../specs/agent-role-memory.zh.md) 仍为 draft。

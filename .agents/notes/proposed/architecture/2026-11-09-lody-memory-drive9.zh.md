# 基于 drive9 的 Lody Memory：以文件存放私有与共享记忆

Status: proposed
Translation: current

[English](2026-11-09-lody-memory-drive9.md)

## 摘要

未发布的 Loro 版 Lody Memory 把每个记忆存为 CRDT 文档。用户无法用普通工具打开、索引或搜索它，个人 E2EE 也阻碍了跨设备使用。
本提案改为把每个记忆存成 Markdown 文件，放在托管的 [drive9](https://drive9.ai/) 文件服务中。
记忆分为**私有**和**共享**两种：私有记忆只经 daemon 的 SDK 访问；共享记忆以读写方式挂载到工作区成员的设备上。可见性在创建后仍可修改。
代价是：记忆内容在托管服务上为明文，记忆只能在线使用，OSS 桌面版没有 Lody Memory。
P1 已验证基本的限定范围文件访问，但固定版本的 Drive9 无法提供限定范围的事件、挂载凭据热轮换或可恢复的文件历史。
[P1 门槛](#p1-实施前验证)仍未满足；这些缺口使原集成方案无法原样实施。

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

- daemon 在内存中保存文件系统 token，通过 `DRIVE9_API_KEY` 将挂载 token 传给子进程，并从子进程环境中移除 `DRIVE9_VAULT_TOKEN`。Vault token 授权的是 secret 读取，并不是限定文件系统范围的 API token。
- Lody 必须避免把 token 写入 `~/.drive9/config`。但仅做到这一点并不能阻止凭据持久化：默认的 FUSE 挂载状态会把 bearer 写入权限为 `0600` 的 JSON 文件。其 `--no-persist-credentials` 选项要求以前台或无监督模式运行，且不适用于 WebDAV。WebDAV 状态不保存 bearer，但内存中的客户端会保留最初的 token。
- 挂载凭据是快照。目前续期需要卸载后重新挂载；修改配置，或让 supervisor 使用已保存的凭据重启，都不能实现热轮换。安全排空、已打开的句柄和刷新失败的处理仍是集成门槛。
- 共享记忆的成员获得 `read, list, search, write, delete`。

在本仓库中，该服务是注入的 `packages/platform` 云端端口，DTO 放在 `packages/cloud-api`。
OSS 桌面版只在本地运行，不发起需认证的产品云请求，因此没有 Lody Memory。是否支持用户自备或自托管的 drive9 端点，仍是未决问题。

## 修改可见性

- **私有 → 共享。** 为成员签发 token，然后在成员设备上挂载。
- **共享 → 私有。** 撤销成员 token，再通知在线 daemon 卸载。其他成员已读过或已缓存在磁盘上的副本无法收回，界面须在确认前说明这一点。

## 来源与并发

- **SDK 写入。** 预期合同要求设置 actor 和 `expectedRevision`，返回冲突而不盲目重试。来源记录需要 `{path, changeId, actor, userId, sessionId, turnId, before/after revision}`。文件系统 token 无权追加 journal。文件写入后再单独追加记录并非原子操作；崩溃恢复和幂等对账仍需设计。
- **挂载写入。** 仍要求能归属到用户和机器。固定版本的 WebDAV 挂载从未配置 `SetActor`，而 `X-Dat9-Actor` 由调用方提供，并非经过认证的身份。FUSE 生成的是挂载 actor，不是提议的 `lody:<userId>:<machineId>` 身份。两者都不能建立可信的来源记录。
- **事件。** 文件系统 token 访问 `/v1/events` 和 `/v1/journals` 均返回 403。Owner SSE 覆盖整个 tenant；所检查的流循环不会重新验证过期或撤销状态。不得向 daemon 分发 owner key 来绕过这一缺口。候选方案是上游支持限定范围的事件及流撤销，或由托管中继在重放和实时投递时校验当前成员关系与路径范围。本文并未实施或批准其中任何方案。
- **挂载并发写入。** WebDAV 缓冲整个文件，并在关闭时无条件写入。锁仅在各 handler 内有效，因此其他挂载或 SDK 写入者的内容可能被覆盖。SDK 版本检查只保护带条件的 SDK 写入，不会让后续 WebDAV 写入也带上条件。
- **历史。** Journal 追加、读取和验证可用，但不会捕获或恢复文件版本。仅靠版本号无法恢复被覆盖的字节；此固定版本拒绝 journal artifact 引用，也没有已实现的 seal 操作。在宣称能够从后写者胜中恢复之前，仍须提供可恢复的不可变内容，并将其与每次变更原子关联。Journal 哈希验证的是一致性，不能证明在有能力重写整条链的管理员面前仍具真实性。

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

P1 不代表实施已获批准。要满足提议的合同，此固定版本的集成仍需完成以下工作：

| 领域 | 证据与剩余门槛 |
| --- | --- |
| 限定范围的访问 | 允许范围内的文件读取成功；同级记忆读取和根目录列举被拒绝。SSE 和 journal 完全不可访问。须设计限定范围的事件投递，且不能向设备发送 tenant owner key。 |
| 续期 | 挂载客户端保留最初的凭据。须建立经过测试的排空/重新挂载协议，或在上游增加轮换能力；无损续期尚未验证。 |
| macOS WebDAV | 使用限定范围 token 的 macOS 挂载读写成功，但通过 `os.replace(tmp, target)` 替换已存在文件时返回 `EINVAL`。过期或撤销后，之前读过的内容仍可从缓存读取；未缓存的读取和新写入失败。原子保存和安全续期仍受阻。 |
| 搜索与并发 | 对英文和中文 Markdown 的字面搜索返回了测试样本；使用旧版本的条件写入返回 409。这不是召回率基准，也不能防止无条件的挂载写入覆盖内容。 |
| 来源与恢复 | Journal 权限控制及追加/验证可用；经过认证的挂载归属、原子来源记录和被覆盖字节的恢复仍未解决。 |
| 托管 | 在 TiDB v8.5.1 上，两个成功样本中的本地 tenant 就绪时间约为 6.6–9.7 秒。这不是托管服务的开通延迟。托管价格、配额和开通 SLA 仍未验证；未开通任何云端 tenant。 |

待定问题：以后是否为成员提供只读角色？当前决定是所有成员均为读写。

## 验证

证据固定于 [`mem9-ai/drive9` commit `b866b426ff4ab8d8409c95e77ad0cc946908bcca`](https://github.com/mem9-ai/drive9/tree/b866b426ff4ab8d8409c95e77ad0cc946908bcca)。
已执行的本地 HTTP 探测使用合成 tenant，以及限制在 `/memories/a/` 的 token，并在 `/memories/b/` 放置第二个记忆。
观测结果为：允许范围内读取返回 200，同级记忆/根目录访问返回 403，事件/journal 访问返回 403，条件写入成功后使用旧版本再次写入返回 409，撤销后新请求返回 401。
搜索在覆盖测试样本之前执行，`pnpm` 和 `中文` 都返回了样本路径。这些观测不能证明实时流撤销、广泛的搜索召回率或应用恢复能力。

可复现的上游测试边界：

- `pkg/server/tokens_test.go`：`TestScopedTokenRevokeInvalidatesToken`。
- `pkg/server/server_test.go`：`TestWriteWithExpectedRevisionConflict`。
- `pkg/server`：`TestScopedBusinessEndpointGuardDeniesEndpointsOutOfWorkspaceZonesScope`、
  `TestJournalPermissionsFromClaimsFailsClosedForScopedKeys`、
  `TestParseFSScopeOpsRejectsSearchWithoutRead`、`TestJournalHTTPCreateAppendSearchVerify`、
  `TestJournalHTTPFullEntriesRequireReadPermission`、
  `TestJournalHTTPAppendSourcePermissions` 和
  `TestJournalHTTPSearchOmitsZeroTimesAndSupportsRepeatedLabels`。

这些测试使用本地 TiDB 数据库执行，命令为 `go test ./pkg/server -run '<test-name-regexp>' -count=1 -v -timeout=180s`。
隔离数据库需要设置 `tidb_ddl_enable_fast_reorg=OFF` 和 `tidb_enable_dist_task=OFF`，以避开本地 DDL ingest 的可用磁盘空间预检查；这不是生产配置建议。

真实的 macOS WebDAV 探测在操作系统挂载表中确认了限定范围的挂载。
API 写入 → 挂载读取、挂载写入 → API 读取均返回一致的内容；API 改名 → 挂载读取也成功。
对已存在文件执行原子替换时返回 errno 22，临时源文件仍存在。
在撤销后，以及另一次使用 20 秒 token 的过期后，新 API 请求返回 401，已缓存的挂载内容仍可读取，未缓存的读取返回 ENOENT，新写入尝试返回 EIO，且未在服务端创建文件。
这不能证明脏句柄或已打开句柄的撤销行为，也不能证明无损续期。探测挂载均已卸载。
单次本地观测中，API 到挂载约为 59 ms，挂载到 API 约为 183 ms，包含子进程和验证开销；这些不是延迟分位数，也不是对托管服务的预测。

仅基于源码的发现还依赖 `pkg/server/auth.go`、`pkg/server/sse.go`、`pkg/server/tokens.go`、`pkg/webdav`、
`cmd/drive9/cli/mount_webdav.go`、CLI 挂载凭据/状态代码和 `clients/drive9-js/src/client.ts`。
源码检查不等于真实挂载或恢复测试。[记忆 Spec](../../../../specs/agent-role-memory.zh.md) 仍为 draft。

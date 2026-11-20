# native 引擎上的云同步与加密工作区

Status: approved · [批准记录](https://github.com/LodyAI/Lody/pull/2955#issuecomment-7028570219)
Translation: current

[English](native-engine-cloud-e2ee.md)

在桌面端和 daemon 上，本地工作区已经可以用 native loro-repo-rs 引擎承载以下数据：

- Workspace Meta；
- `wf`、`mf`、`sr` 三张 Flock 表；
- Session、`schedule-*` 和 Preview comment 这几类 Loro 文档。

这条路径由默认关闭的开关控制。云工作区和加密（E2EE）工作区仍然走旧的 JS loro-repo 路径。

用户在这台桌面上登录后，期望云工作区和加密工作区的行为和现在一样。手机、Web 和旧版桌面在同一个工作区里照常工作。服务端始终看不到明文。

本 Spec 决定 native 引擎如何接入这些工作区。它只是设计，不改产品代码。

## Owner 决定

owner 于 2026-11-20 给出以下决定，本文不重新讨论：

1. 引擎用 SDK keyring 封装、签名和解封加密内容。core 通过一条专用路径把密钥和设备签名种子安装进去，不提供通用导出。数据进程是受信任进程，多一个持有方可以接受。
2. 加密工作区先于普通云工作区上线。
3. 写入者绑定连接（K1）是阶段 1 的前置项；不做对端进程验证。
4. 设计保持最简：
   - 数据进程一个人包办存储、同步和加解密；
   - main 和 daemon 只负责把密钥交过去，并随状态更新；
   - renderer 只经 main 读明文，不接触密钥。

## 决定

### 1. 同一组 stream、同样的字节；云上数据不迁移

native 房间同步到**现有的 Loro Streams stream，使用现有格式**：

- **stream**：同一个 bucket，同样的 `<workspaceId>:meta`、`:s:`、`:schedule:`、`:pc:`、`:wf:`、`:mf:`、`:sr` stream id，即 SDK 里的 Lody 路由表；
- **格式**：带长度前缀的 update 追加、共享的快照编码，以及 HEAD/bootstrap 追赶；
- **加密工作区**：LSCE v2（provider header 为 `[3]`/`[4]`）、基于命名空间 `lody-e2ee:<genesis>` 的 loro-repo 房间 AAD 包装，以及 content-v0 帧。

已有的线上格式和持久化格式都不改，本设计也不需要改。格式一致，因此：

- **云上数据不迁移。** 旧客户端和新客户端写同一组 stream，收敛方式仍是现在的 Loro/Flock 合并。
- **新旧客户端共处同一工作区，不需要新规则。** 包括旧版桌面、Web、手机 webview，以及服务端的几个写入方（会话 bootstrap、提交、PR webhook）。
- **native 客户端首次使用时接管本机的旧本地存储。** 接管走[工作区 bundle](workspace-export-import.zh.md#native-迁移) 的 `legacy-repo` 源适配器：
  - 原始房间字节和 stream checkpoint 一起迁移；
  - 尚未上传的编辑以原写入者身份排队上传。

native 自身的本地存储没有已发布的数据，不为它自己的旧格式保留兼容层。

格式一致是前提，不是假设。阶段 0 用两类数据证明这一点：当前产品客户端录下的帧，以及服务端写入方产生的帧。不能只用 SDK 自己的重新实现来证明。

如果 SDK 将来需要不同的行为（例如快照压缩），必须加一个能复现旧字节的选项，不能改格式。

### 2. 每台设备一个本地所有者；只有云端组合才接云

native 宿主仍然是每个平台数据目录一个进程，由 `files.lock` 保证唯一。daemon 和 Electron main 各持一条连接。因此每台设备上每个房间只有一份副本，native 房间不再需要 renderer↔daemon 的本地数据面。

以下三样只由云端组合安装，而且要在工作区准入之后：

- remote；
- token provider；
- keyring 材料。

OSS 桌面从不配置 remote，也不发任何云请求。

remote 配置可以持久化，token 只放在内存里。宿主重启后：

- 没有 token provider，就停在 `auth_required`；
- 没有已安装的密钥，就停在 `protection_blocked`。

两种状态下都不会发出任何数据。

### 3. 哪些房间保持实时

**始终实时：** 工作区打开期间，Meta 和 `wf`/`mf`/`sr` 目录始终实时同步。

**打开时实时：** Session、schedule、Preview comment 房间在 renderer 视图或 daemon 副本打开期间实时同步。

**按需拉取：** 其余房间在打开时才拉取。

daemon 仍然像现在一样，通过它已经在监听的 Meta 和机器房间得知远端的新输入。

实时订阅必须按房间粒度。在用户主路径上，对几千个 Session 房间做整个命名空间的同步是不可接受的。这需要一个 SDK 原语（S1）。

### 4. 离线、重连和终止边界

**本地提交：** 写入在引擎里落盘后即视为已接受。SDK 的 outbox 会一直保留这条写入，直到服务端确认。

**重发与拉取：**

- 已封装的行按原字节重发，不会重新封装。
- 拉取的 checkpoint 只在导入的状态落盘后才前进。
- 服务端在快照 48 小时后裁剪历史；之后的 `410` 会从快照重新 bootstrap。

以上保持了[运行时生命周期](workspace-runtime-lifecycle.zh.md)的保证：已提交的离线编辑在关闭后仍然保留，关闭不等待上传。

**终止边界：** 退出、登出和删除工作区遵循 [failure containment](../.agents/docs/failure-containment.md)：

1. 给 outbox 排空设一个有界期限；
2. 报告仍未上传的行；
3. 然后终止。

未上传的行仍在引擎的持久 outbox 里，下次启动时上传。

**关闭开关：** 对云工作区关闭 native 是安全的。

- 已上传的内容都在云上，旧存储从云端追上即可。
- 尚未上传的行，由现有的回写交给旧存储，再由旧路径上传。

### 5. 加密工作区：加解密由引擎完成

引擎用 SDK 的 keyring（`LodyKeyringProtector`：LSCE v2、`[3]`/`[4]` header、content-v0）自己完成封装、签名和解封，不再有任何加解密方面的反向 RPC。

main 和 daemon 里的 core 保留所有授权决定：账本验证、密钥接收与分发、轮换、恢复、机器共享。它只负责把引擎需要的材料交过去，并在自身状态变化时更新这些材料。

**安装什么**：每个加密命名空间安装以下材料：

- 已 pin 的 genesis；
- 已验证的 epoch 密钥，不含已废弃的 epoch；
- 封装 epoch；
- 所有历史上准入过的设备公钥；
- 设备有写权限时，本进程的写入者签名种子。

**由谁安装**：Electron main 为个人设备安装，daemon 为机器身份安装。renderer 从不安装任何东西，也拿不到密钥材料。

**通知机制**：每个触发点只有一个推送方，每次只推送一种内容：

| 触发点 | 推送方 | 引擎收到什么 |
| ------ | ------ | ------------ |
| 内容打开准入通过，且 core 里已有可用密钥 | main 或 daemon | 全量安装 |
| 新 epoch 在 core 里提交并安装 | 同上 | 安装该 epoch，再把封装 epoch 切过去 |
| 账本前进或有新设备准入 | 同上 | 准入新的公钥 |
| 本设备失去写权限（Guest、角色变更、15 分钟 epoch 预算用尽） | 同上 | 暂停该写入者的封装和快照上传；准入和旧 epoch 保留 |
| 本设备所属成员被移除，或本设备被吊销 | 同上 | 清除 keyring，删除 remote，删除命名空间 |
| 宿主重启、重连或交接给新 build | 同上，在重连时 | 全量重装（keyring 不落盘） |

被吊销或被移除成员的公钥仍保留准入，他们的历史帧因此仍然可读，这是 core 的要求。密钥到达之前写入的行停在 `protection_blocked`，不会回退到任何其他方式。

**为什么不会泄露给其他应用**：

- **只写不读**：引擎没有任何返回密钥材料的请求。它只提供内容封装和解封，不提供通用签名接口。
- **只有本用户能访问**：socket 和 `engine.json` 的权限都是 0600，位于该用户的数据目录里。
- **只有一条通道**：密钥只从 main 或 daemon 经二进制帧发给引擎，不经过 renderer、磁盘、JSON 或日志。
- **写入者绑定连接（K1）**：只有安装了某个写入者种子的那条连接，才能以该写入者身份封装内容。其他本机进程手上没有种子可装，也用不了别人装进来的种子。

**接受的代价**：宿主成为第三个在内存里持有密钥和设备种子的进程。owner 接受这一点，因为数据进程是 Lody 自己管理的受信任进程。唯一的缓解措施是：宿主进程关闭 core dump，不接入崩溃上报。

**移除与清理**：凭据确认成员被移除或本设备被吊销时，Lody 依次：

1. 在该工作区的身份记录旁写一个持久的"待清除"标记；
2. 清除 keyring；
3. 删除 remote；
4. 删除命名空间（E1）。

`dropNamespace` 成功返回即为完成确认，只有它能清掉标记。

如果当时宿主不在线：keyring 不落盘，所以本来就没有要清的密钥。下次连接时，Lody 先补完第 2–4 步，再处理该命名空间的任何其他请求。标记存在期间，内容打开准入拒绝该命名空间。清除失败时报告并重试，不阻塞其他工作。

**不变的规则**：

- 内容在上传时封装，使用当时的封装 epoch；因此离线期间被移除的设备，之后的编辑不会上传。
- 经过认证的模式判定之前不配置 remote；判定结果矛盾时，临时明文命名空间退役，永不发送。
- 房间加密策略在创建时固定。
- 快照上传沿用现在的加密策略（S3）。
- 账本、成员、设备、[恢复](e2ee/recovery-vault.zh.md)和[机器共享](e2ee/machine-sharing.zh.md)都不变。

**不变量修订**：这里只写草案，实际修改在实现 PR 里落地；修订依据是 owner 决定 1。

`packages/e2ee-core/INVARIANTS.md`，在 "Epoch keys have no public byte export" 之后加：

> The single exception is `installIntoEngineKeyring`. It copies verified epoch
> keys, admitted public keys and the caller's own writer seed only into the
> local native engine connection of the same installation, in binary install
> frames. It wipes every copy afterwards. The engine exposes content sealing
> and opening only: it never signs ledger or governance records, never returns
> key material, and never becomes ledger authority.

`packages/e2ee-core/src/internal/keys/AGENTS.md`，在 "Never add a generic secret export …" 后补：

> except `installIntoEngineKeyring`, which borrows through
> `InstalledEpochKeys`.

### 6. 明文只在本地；新增的泄露面

离开设备的只有密文：update、快照和 Flock bundle 在上传前都已封装。presence 仍走独立通道，只发已批准的白名单字段。

**本地存储：** 引擎的本地存储是明文，和旧存储一样。[白皮书 §1.2](e2ee/whitepaper.zh.md) 规定本地内容沿用现有存储，所以这不是新的落盘泄露。

新增的本地泄露面有两个。

**一、renderer 远程读取。** 明文现在经分页 IPC 到达 renderer，而不是 renderer 持有副本。main 必须对每个请求做以下检查：

- **工作区范围：** 命名空间必须是该 renderer 当前已准入的工作区。
- **会话读权限：** Session 只能按现有的[会话读权限规则](session-access.zh.md)读取。云工作区里有其他成员的私有会话，只检查"本地唯一工作区"是不够的。
- **失去访问权：** 失去访问权时，关闭该命名空间的所有视图，丢弃迟到的回复。
- **写入授权：** 写入授权不变。`humanInputReceipts` 只为当前本地用户盖章，签名的执行意图仍留在 main。

renderer 持有的明文比现在少，但它不能随意指定房间来读。

**二、引擎 socket。** 由第 5 节覆盖：对密钥只写不读、只有本用户可访问、按写入者绑定连接。

**日志与诊断：** 引擎的错误和诊断信息不得携带明文。

### 7. Roost

Roost 与 native 云同步**共存**。本设计里，两者都不迁移进对方。

**两者各自承载的内容：**

- Roost 历史仍由所属机器持有，通过所有者订阅和 RPC 读取；
- native 的 Streams 房间承载 Meta、目录和 Session 的控制面文档；
- LSCE 不覆盖 Roost stream；
- Lody 在这里不使用引擎自带的 RoostStream 房间。

**授权语义一致：** 会话读权限与后端无关。将来 Roost 成为默认历史后端时，以及 E2EE 支持 Roost 时，都使用同一套[会话读准入](session-access.zh.md)，不增加按后端区分的授权。

### 8. Web 与手机 webview

浏览器里没有 native 引擎。Web 和手机 webview 继续使用 JS 技术栈：loro-repo、streams-crdt、IndexedDB，以及 `@lody/e2ee-client`。

它们能与 native 桌面互通，完全依赖线上格式一致（第 1 节），所以格式一致是发布门槛。

把引擎编译成 WASM 不在本设计范围内。

## SDK 原语

按阻塞程度排序，名字是草案。SDK 中不出现 Lody 的领域概念。

| 编号 | 阻塞 | 原语（草案） |
| ---- | ---- | ------------ |
| K0 | E2EE | **宿主内的 keyring**：现在 `ContentKeyring` 跑在 napi 客户端进程里，宿主协议也没有安装请求。需要新增走二进制帧的安装请求：`keyringConfigure(ns, genesis)`、`keyringInstallEpoch`、`keyringSetSigner(ns, writer, seed)`、`keyringAdmit`、`keyringClear`。宿主在清除、删除命名空间、交接和退出时清零；没有任何请求返回密钥材料。 |
| K1 | E2EE | **写入者绑定连接**：只有安装了写入者 W 种子的那条连接，才能以 W 的身份写入和封装。 |
| K2 | E2EE | **封装策略与准入分离**：`keyringSetSealEpoch(ns, epoch)`，以及 `keyringHoldSealing(ns, writer)` / `release`。暂停封装时保留准入和旧 epoch，这一点与 `revokeWriterPubkey` 不同。 |
| S1 | 云同步 | 按房间的实时订阅与拉取：`setRoomInterest(ns, rooms, {live})`、`syncRooms(ns, rooms)`。同时修正二进制 Loro-update 订阅，使它也计入订阅。 |
| S2 | 云同步 | token 回复携带 `{token, expiresAt?, baseUrl?, bucket?, shardUrls?}`，并在过期前刷新。加密内容 token 有效期 8 分钟，且自带 bucket。 |
| S3 | 云同步、E2EE | 每个 remote 的快照上传策略：`{debounceMs, minBytes, maxBytes}`；由 Lody 推送的 `setSnapshotUpload(ns, allowed)` 开关；以及响应修复请求的 `uploadSnapshotNow(ns, room)`。快照字节必须与旧编码一致。 |
| S4 | 云同步 | 远端导入永远不被本地 `docSchema` 拒绝。先验证，验证不通过才补这个原语。 |
| E1 | E2EE | `dropNamespace(ns)`：排空、关闭，并持久删除命名空间的数据库和 outbox。删除持久完成后的回复即为完成确认。 |
| N2 | — | 用流式实时传输（SSE 或 WebSocket）代替 long-poll。 |

npm 发布版必须包含发布构建用到的全部原语。0.1.0 早于其中大部分原语。

## 分阶段计划

行数是 Lody 产品代码的粗略估计，不含 SDK。按 owner 决定 2，先上加密工作区。

| 阶段 | 范围 | 验收 | 回滚 | 行数 |
| ---- | ---- | ---- | ---- | ---- |
| 0 | 证明格式一致；K0–K2、S1–S4、E1 合入并发版。 | keyring 封装的帧能在真实的 `@lody/e2ee-core` 里解封，core 封装的帧也能在 keyring 里解封。覆盖：Loro 和 Flock 的 update 与快照、轮换后读旧 epoch、暂停封装、事后被吊销的作者，以及篡改 AAD、文档或 epoch。另加产品客户端和服务端写入方录下的明文帧和加密帧。 | 不涉及。 | 约 400（测试） |
| 1 | 桌面和 daemon 上的**加密**工作区，用独立开关控制。包括：同步核心（准入后配置 remote、token provider、实时订阅、接管旧存储、终止时排空）、安装与通知表、待清除标记的清理、renderer 读取检查。 | 私有仓库 E2E 加入 native 设备：persistence、snapshots、recovery、collaboration、canary 明文外泄审计；layer-B 的 `skew-convex-slow`（在线轮换）和 `transient-503`；native 桌面与 JS Web 设备混合；杀掉宿主和交接后重装；宿主不在线时移除成员。 | 关闭开关：旧存储从云端重新同步，未上传的行回写。 | 约 1700 |
| 2 | 普通云工作区复用同一核心。 | 打开 native 跑 CLOUDSYNC-001 和 cloud journey；layer-B 的 WAN 配置；W6 时钟偏差；关闭后再打开开关。 | 同阶段 1。 | 约 500 |
| 3 | 观察期后默认打开，再删除桌面和 daemon 的旧路径。Web 和手机不变。 | 完整的 `verify:release`。 | 回退发布。 | 净减少 |

私有仓库的测试工具目前还没有 native 设备角色，阶段 1 需要补上。

## 待 owner 决定的问题

没有。

## 依据

- **意图**：
  - 2026-11-20 转达的 owner 方向：E2EE 优先、Roost 将成默认、权限本地验证、不改格式、可用性优先。
  - owner 于 2026-11-20 在主控会话中给出决定 1–4，记录在 [#2955](https://github.com/LodyAI/Lody/pull/2955)。
  - owner 于 2026-11-20 批准本修订（`f4bd8d1c0`，[批准记录](https://github.com/LodyAI/Lody/pull/2955#issuecomment-7028570219)）。
- **已检查**：
  - native 实现栈：draft PR #2902–#2942（顶层 `native-desktop-acceptance-fixes` @ `840f6d05`），以及设计文档 `.agents/docs/native-workspace-meta.md`。
  - loro-dev/loro-repo `main` @ `ad97aa3`：
    - `rust/packages/client`：remote、auth、status 类型；
    - `rust/npm/engine`：`ContentKeyring`；
    - `rust/crates/loro-repo-types`：没有 keyring 请求；
    - `rust/docs/architecture.md` 和 `lody-routes` 路由表。
  - Lody：[Workspace Streams 内容边界](workspace-streams-content.zh.md)、[E2EE 基础](e2ee-foundations.zh.md)、[白皮书](e2ee/whitepaper.zh.md)、[平台 E2EE 规则](../packages/platform/AGENTS.md#e2ee-workspace-control)、[core 不变量](../packages/e2ee-core/INVARIANTS.md)、[密钥规则](../packages/e2ee-core/src/internal/keys/AGENTS.md)、[客户端规则](../packages/e2ee-client/AGENTS.md)、[bootstrap 指南](../.agents/docs/e2ee-workspace-bootstrap.zh.md)。
- **未执行**：尚未运行任何验证。SDK 内部只用它自己重新实现的 content-v0 测过 keyring 与 core 一致；阶段 0 改用真实的 core 包测试。
- **后端**：只属于后端的细节放在私有仓库的设计文档里。

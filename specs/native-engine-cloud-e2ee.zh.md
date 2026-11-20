# native 引擎上的云同步与加密工作区

Status: draft
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

1. native 引擎用 SDK keyring 封装和解封加密内容。core 只能通过一条专用、窄口径的路径把密钥安装进该 keyring，不提供通用导出。
2. 加密工作区先于普通云工作区上线。

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

### 5. 加密工作区：加解密放在引擎 keyring 里

按 owner 决定 1，native 引擎用 SDK 的 keyring（`LodyKeyringProtector`：LSCE v2、`[3]`/`[4]` header、content-v0）自己完成封装和解封，不再为每一帧经反向 RPC 调用 core。

其余职责仍留在 core：

- 账本验证与 pin；
- 从 mailbox 接收密钥、安装和分发；
- 轮换与发布；
- 恢复；
- 机器共享检查。

**引擎与 core 的分工：**

| 事项 | 引擎 keyring | Lody core（main 或 daemon） |
| ---- | ------------ | --------------------------- |
| 封装和解封时的 AEAD、签名、AAD、快照 offset 检查 | 是 | — |
| 哪些公钥可以作为内容作者 | 使用已准入集合 | 从已验证账本提供所有历史上准入过的设备公钥 |
| 本设备现在能否写 | 没有 signer 或封装被暂停时拒绝 | 按角色和访问权安装、暂停或移除 signer |
| 新内容用哪个 epoch | 使用给定的封装 epoch | 设为已验证的当前 epoch；15 分钟预算期间设为保留 epoch，预算用尽后暂停 |
| epoch 密钥 | 只放在内存里 | 持有持久副本，决定安装什么 |

上表把"当前写权限"和"历史作者准入"分开了：

- 被吊销或被移除成员的设备公钥仍然保留准入，用于解封，所以他们的历史帧仍然可读，这是 core 的要求。
- `revokeWriterPubkey` 只用于本设备自己的公钥，而且只在它也必须停止解封时使用。
- 失去写权限时（成为 Guest、恢复设备、角色变更、epoch 预算用尽），只暂停封装，不动准入。这需要 SDK 原语 K2。

#### 安装路径（密钥离开 core 的唯一途径）

core 新增一个窄口径操作 `installIntoEngineKeyring`。它是密钥离开 core 的唯一途径，只把材料交给本机引擎。

**每个加密命名空间安装的材料：**

- 已 pin 的 genesis；
- 已验证的 epoch 密钥，不含已废弃的 epoch；
- 封装 epoch；
- 所有历史上准入过的设备公钥；
- 设备有写权限时，本进程自己的写入者 signer。

signer 具体交什么，见开放问题 2。

**由谁安装：**

- Electron main 从[桌面托管](e2ee/desktop-custody.zh.md)为个人设备安装；
- daemon 为它的机器身份安装；
- 各自绑定自己的 writer id；
- renderer 从不安装，也拿不到任何密钥材料。

**何时安装：**

- 内容打开准入之后，并且 core 里已有可用密钥时；
- 新 epoch 在 core 里真正提交并安装后，补装它；
- 已验证账本前进时，补充新准入的设备公钥；
- 每次重连后重装。keyring 不落盘，所以宿主重启或 build 交接后都是空的。

装上之前，房间报告 `protection_blocked`：保留 checkpoint 和本地数据，不回退到任何其他方式。

**core 在这条路径上必须守住：**

- **只交给已验证的本机连接。** 只发给 engine endpoint 与本安装的数据目录和协议都匹配的连接，并且只走专用的二进制安装请求（K0）。密钥绝不经过 JSON、日志、发给 renderer 的 IPC 或磁盘。
- **来源唯一。** 材料通过 `InstalledEpochKeys` 现有的借用方式取得。引擎确认、拒绝或连接失败后，用 `acquireUseRelease` 擦除每一份副本。
- **不能挪作他用。** 这不是通用导出。它只接受引擎连接这一种能力，产品 RPC、MCP 和 renderer 都调不到。

#### 轮换、移除与清理

**轮换：** core 先安装新 epoch，再把封装 epoch 切过去。已封装的帧仍然有效，旧 epoch 保留安装，用于读历史。不需要暂停 remote。

**epoch 废弃：** 已废弃的 epoch（tag 11）不安装；如果已经装了，就把它从封装中撤下。

**本设备失去访问权：** 凭据确认的成员移除或本设备被吊销时，Lody 依次：

1. 在该工作区的身份记录旁写一个持久的"待清除"标记；
2. 调用 `clearNamespace`，清掉密钥和准入；
3. 删除 remote；
4. 通过 E1 删除命名空间，包括数据库和 outbox。

`dropNamespace` 成功返回即为清理完成的确认，只有它能清掉标记。

**移除时宿主不在线或连不上：**

- keyring 从不落盘，所以本来就没有要清的密钥；
- 待清除标记保留；
- 下次连接时，Lody 先执行第 2–4 步，再处理该命名空间的任何其他请求；
- 标记存在期间，内容打开准入拒绝该命名空间；
- 清理失败时报告错误，每次连接都重试，不阻塞其他工作。

**移除其他成员：** 只影响被移除成员自己设备在封装时的写权限检查，他们的历史帧仍然可读。

#### 不变的规则

以下规则不变：

- 在上传时封装，使用当时的封装 epoch；离线期间被移除的设备，之后的编辑不会上传。
- 经过认证的模式判定之前不配置 remote；判定结果矛盾时，临时明文命名空间退役且永不发送。
- 房间加密策略在创建时固定，不一致时失败关闭。
- 快照上传沿用现在的加密策略（S3）。
- 密钥仍来自已验证账本和 mailbox。账本、成员、设备、[恢复](e2ee/recovery-vault.zh.md)和[机器共享](e2ee/machine-sharing.zh.md)都不变。

#### 代价与缓解

| 代价 | 缓解 |
| ---- | ---- |
| 密钥多了一个持有进程：宿主，在 main 和 daemon 之外。 | 只装进已验证的本机连接；最小化安装（不装已废弃 epoch，只读设备不装 signer）；清除、删除命名空间和退出时清零。 |
| 宿主运行期间密钥一直驻留内存，而宿主比窗口活得长。 | 工作区关闭或失去访问权时调用 `clearNamespace`；宿主空闲时本来就会退出；build 交接时先排空并清零，再释放 `files.lock`。 |
| 宿主崩溃转储或 swap 里可能有密钥。 | 宿主进程关闭 core dump，不接崩溃上报，不上传 minidump；系统允许时用 `mlock`，明确说明这只是尽力而为。 |
| 走 JSON 传输时，Node 堆里会留下无法擦除的 base64 副本。 | 使用二进制安装帧（K0）；Node 侧只保留 `Uint8Array` 副本，用完擦除。 |
| 同一 OS 用户下的进程可以把 socket 当作封装预言机，以本设备身份伪造内容。 | 写入者绑定连接（K1，见开放问题 1）。 |
| 内容加解密有了第二份实现。 | 阶段 0 对真实的 `@lody/e2ee-core` 做双向字节一致性测试。 |

#### 不变量修订（草案，在实现阶段落地）

core 的规则写着"epoch 密钥没有公开的字节导出"，keys 的 AGENTS.md 写着"绝不增加通用的秘密导出"。owner 决定 1 批准了一个窄口径例外，实现 PR 按下面修改两份文件。

`packages/e2ee-core/INVARIANTS.md`，在 "Epoch keys have no public byte export" 之后加：

> The single exception is `installIntoEngineKeyring`. It copies verified epoch
> keys, and the caller's own writer signer where permitted, only into the local
> native engine keyring connection of the same installation, through its binary
> install request. It wipes every copy on every exit. It never writes, logs or
> returns material to callers, and it is not reachable from product RPC, MCP or
> renderers. The engine never becomes ledger authority. See
> `specs/native-engine-cloud-e2ee.md`.

`packages/e2ee-core/src/internal/keys/AGENTS.md`，在 "Never add a generic secret export …" 后补：

> except `installIntoEngineKeyring`, which borrows through
> `InstalledEpochKeys` like every other workflow.

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

**二、引擎 socket。** socket 的权限是 0600，每条连接都拥有完整 API，而且宿主现在会在运行期间一直持有密钥。

只以 OS 用户为边界时，同一用户下的进程经 API 能做两件事：

- 读明文：这一点它本来就能从本地存储读到；
- 以本设备身份封装任意内容：现在它做不到，除非先从托管方把密钥取出来。

它读不到密钥字节，因为没有任何请求会返回密钥。

比较了两种缓解方式：

- **写入者绑定连接（K1）：** 归属某个写入者的行，只接受安装了该写入者 signer 的那条连接。它在所有系统上都能堵住伪造预言机，SDK 改动也小。
- **连接认证：** `engine.json` 里放 token 对同一用户毫无作用；真正的对端验证要靠代码签名或对端凭据，必须按平台分别实现。

要求哪一种，见开放问题 1。

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

它们能与 native 桌面互通，完全依赖线上格式一致（决定 1），所以格式一致是发布门槛。

把引擎编译成 WASM 不在本设计范围内。

## SDK 原语

按阻塞程度排序，名字是草案。SDK 中不出现 Lody 的领域概念。

| 编号 | 阻塞 | 原语（草案） |
| ---- | ---- | ------------ |
| K0 | E2EE | **宿主内的 keyring，经 socket 配置。** 现在 `ContentKeyring` 跑在 napi 客户端进程里，宿主协议也没有安装请求。草案为 `keyringConfigure(ns, genesis)`、`keyringInstallEpoch(ns, epoch, key)`、`keyringSetSigner(ns, writer, seed)`、`keyringAdmit(ns, pubkeys)`、`keyringClear(ns)`。密钥字节走二进制帧，绝不走 JSON；宿主在清除、删除命名空间、交接和退出时清零；没有任何请求会返回密钥。 |
| K1 | E2EE | **写入者绑定连接。** 归属写入者 W 的写入，只接受安装了 W 的 signer 的那条连接。该连接断开后，W 未封装的行等待重新安装。 |
| K2 | E2EE | **封装策略与准入分离。** 用 `keyringSetSealEpoch(ns, epoch)` 取代"最高已安装 epoch"。另加 `keyringHoldSealing(ns, writer)` 和对应的 `release`，以及 `keyringRemoveSigner(ns, writer)`；移除 signer 后，该写入者的公钥仍保留准入，用于解封。 |
| S1 | 云同步 | 按房间的实时订阅与拉取：`setRoomInterest(ns, rooms, {live})`、`syncRooms(ns, rooms)`。修正二进制 Loro-update 订阅，使它也计入订阅。 |
| S2 | 云同步 | token 回复携带 `{token, expiresAt?, baseUrl?, bucket?, shardUrls?}`，并在过期前刷新。加密内容 token 有效期 8 分钟，且自带 bucket。 |
| S3 | 云同步、E2EE | 每个 remote 的快照上传策略：`{debounceMs, minBytes, maxBytes}`，`canUploadSnapshot(ns, room)` 反向 RPC，以及响应修复请求的 `uploadSnapshotNow(ns, room)`。快照字节必须与旧编码一致。 |
| S4 | 云同步 | 远端导入永远不被本地 `docSchema` 拒绝，schema 只约束本地 patch。先验证；验证不通过才补原语。 |
| E1 | E2EE | `dropNamespace(ns)`：排空、关闭，并持久删除命名空间的数据库和 outbox。持久完成后的回复即为完成确认。 |
| K3 | E2EE，开放问题 2 选 (b) 或 (c) 时需要 | 外部签名：引擎内完成加密和验证，但每个封装帧都请安装它的连接来签名。 |
| N1 | — | socket 的对端验证（代码签名或对端凭据），见开放问题 1。 |
| N2 | — | 用流式实时传输（SSE 或 WebSocket）代替 long-poll。 |

npm 发布版必须包含发布构建用到的全部原语。0.1.0 早于其中大部分原语。

## 分阶段计划

行数是 Lody 产品代码的粗略估计，不含 SDK。按 owner 决定 2，先上加密工作区。

| 阶段 | 范围 | 验收 | 回滚 | 行数 |
| ---- | ---- | ---- | ---- | ---- |
| 0 | 证明格式一致；K0–K2、S1–S4、E1 合入并发版。 | **keyring 与 core 的一致性**，对真实的 `@lody/e2ee-core` 双向测试：keyring 封装的帧能在 core 里解封，反之亦然；覆盖 Loro 和 Flock 的 update、带 continuation offset 的快照；轮换（新的封装 epoch，旧 epoch 的帧仍能解封）；保留 epoch 预算用尽后暂停；已废弃 epoch；事后被吊销的作者仍能解封；篡改 AAD、文档或 epoch 时失败。**录制帧**：当前产品客户端和服务端写入方产生的明文帧和加密帧。 | 不涉及。 | 约 500（测试） |
| 1 | 桌面和 daemon 上的**加密**工作区，用独立开关控制。包括同步核心（准入后配置 remote、token provider、实时订阅、接管旧存储、终止时排空）、安装路径、写入者绑定连接、待清除标记的清理，以及 renderer 读取检查。 | 私有仓库 E2E 加入 native 设备：persistence、snapshots、recovery、collaboration、canary 明文外泄审计；layer-B 的 `skew-convex-slow`（在线轮换）和 `transient-503`；native 桌面与 JS Web 设备混合；杀掉宿主和 build 交接后密钥重装；宿主不在线时移除成员，下次连接时完成清除。 | 关闭开关：旧存储从云端重新同步，未上传的行回写。 | 约 2200 |
| 2 | 普通云工作区复用同一核心。 | 打开 native 跑 CLOUDSYNC-001 和 cloud journey；layer-B 的 WAN 配置；W6 时钟偏差；关闭后再打开开关。 | 同阶段 1。 | 约 600 |
| 3 | 观察期后默认打开，再删除桌面和 daemon 的旧路径。Web 和手机不变。 | 完整的 `verify:release`。 | 回退发布。 | 净减少 |

私有仓库的测试工具目前还没有 native 设备角色，阶段 1 需要补上。

## 待 owner 决定的问题

1. **宿主持有密钥之后，引擎 socket 怎么加固。**
   - **背景：** 同一 OS 用户下的进程可以调用完整 API。它本来就能读本地明文，也读不到密钥字节。新增的风险是，它能以本设备的签名封装内容。
   - **选项：**
     - (a) 只以 OS 用户为边界：零成本，但伪造预言机仍在。
     - (b) 写入者绑定连接（K1）：SDK 小改动，在所有系统上都能堵住伪造预言机，不需要按平台做工作；明文读取仍以 OS 用户为边界。
     - (c) 在 (b) 的基础上再加对端验证（N1）：需要按系统分别实现，macOS 和 Windows 上有效，Linux 上较弱。
   - **推荐：** (b)，作为阶段 1 的阻塞项；(c) 之后再做，不阻塞。
2. **设备签名种子是否交给引擎。**
   - **背景：** 内容签名用的是设备的 Ed25519 身份密钥。在 Owner/Admin 设备上，同一把密钥还签账本的治理记录。签名域分离保证引擎 API 签不出账本签名；但如果种子泄露（例如从崩溃转储或内存里），攻击者就能以该设备身份伪造治理记录。只交 epoch 密钥时，泄露的只是内容。
   - **选项：**
     - (a) 交出种子：全部在引擎里完成，没有反向 RPC。
     - (b) 签名留在托管方（K3）：只有封装时需要一次签名往返；解封是追赶时的热路径，完全在引擎里完成。
     - (c) 只为机器身份交出种子（机器不签治理记录），个人设备用 (b)。
   - **推荐：** (c)。本地写入是批量的，每次封装一次签名往返的开销很小，个人身份密钥也因此留在托管方。

## 依据

- **意图：**
  - 2026-11-20 转达的 owner 方向：E2EE 优先、Roost 将成默认、权限本地验证、不改格式、可用性优先。
  - owner 决定 1（加解密放进引擎 keyring，core 开一个窄口径的安装例外）和决定 2（先上加密工作区）：owner 于 2026-11-20 在主控会话中给出，记录在 [#2955](https://github.com/LodyAI/Lody/pull/2955)。
  - 本修订尚未批准。
- **已检查：**
  - native 实现栈：draft PR #2902–#2942（顶层 `native-desktop-acceptance-fixes` @ `840f6d05`），及其设计文档 `.agents/docs/native-workspace-meta.md`。
  - loro-dev/loro-repo `main` @ `ad97aa3`：
    - `rust/packages/client`：remote、protector、auth、status 类型；
    - `rust/npm/engine`：`ContentKeyring`；
    - `rust/crates/loro-repo-types`：没有 keyring 请求；
    - `rust/docs/architecture.md` 和 `lody-routes` 路由表。
  - Lody：[Workspace Streams 内容边界](workspace-streams-content.zh.md)、[E2EE 基础](e2ee-foundations.zh.md)、[白皮书](e2ee/whitepaper.zh.md)、[平台 E2EE 规则](../packages/platform/AGENTS.md#e2ee-workspace-control)、[core 不变量](../packages/e2ee-core/INVARIANTS.md)、[密钥规则](../packages/e2ee-core/src/internal/keys/AGENTS.md)、[客户端规则](../packages/e2ee-client/AGENTS.md)、[bootstrap 指南](../.agents/docs/e2ee-workspace-bootstrap.zh.md)。
- **未执行：** 尚未运行任何验证。SDK 内部只用它自己重新实现的 content-v0 测过 keyring 与 core 一致，阶段 0 改用真实的 core 包测试。
- **后端：** 只属于后端的细节放在私有仓库的设计文档里。

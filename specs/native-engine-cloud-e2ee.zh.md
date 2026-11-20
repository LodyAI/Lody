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

以下三样只由云端组合注册，而且要在工作区准入之后：

- remote；
- token provider；
- protector。

OSS 桌面从不配置 remote，也不发任何云请求。

remote 配置可以持久化，token 只放在内存里。宿主重启后：

- 没有 token provider，就停在 `auth_required`；
- 没有 protector，就停在 `protection_blocked`。

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

### 5. 加密工作区：加解密留在密钥托管方

引擎只负责存储和复制，从不持有 epoch 密钥、设备密钥或账本权威。

**谁来加解密：** 加密和解密都在 `@lody/e2ee-core` 里运行，经 SDK 的 protector 反向 RPC 调用：

- Electron main 通过[桌面托管](e2ee/desktop-custody.zh.md)为个人设备注册；
- daemon 为它的机器身份注册；
- 各自只注册**精确的 writer id**。每条 outbox 行都带有写入者，只有该写入者的 protector 能封装它。

renderer 的写入经过 main，因此归属个人设备并由它封装；daemon 自己的写入由机器封装。

**检查全部沿用：** core 里现有的检查一项不变：

- 加密前检查当前写权限，签名后再查一次；
- 使用当前 epoch，并沿用 15 分钟的保留 epoch 预算；
- 作者必须在历史上被准入过；
- 快照由产生者在其 continuation offset 处签名；
- 不回退到明文。

SDK 里引擎内置的 `ContentKeyring` 只用于测试。

**封装时机：** 封装发生在上传时，而不是提交时。离线编辑在重新联网时封装，使用的是当时的当前 epoch，并按当时的写权限检查。

因此，离线期间被移除的设备，之后的编辑不会上传。它的本地数据按现有的失去访问权流程处理。

**引擎不感知的部分：** 以下内容都不变，引擎也不感知：

- 密钥仍然来自已验证的账本和 mailbox；
- 轮换和移除遵循[原子移除](e2ee/atomic-removal.zh.md)；
- [恢复](e2ee/recovery-vault.zh.md)通过 core 安装密钥；
- [机器共享](e2ee/machine-sharing.zh.md)仍在 daemon 里检查执行权限。

**轮换：** 不需要暂停引擎。下一次封装就使用新 epoch，已封装的帧仍然有效。

**移除与吊销：** 凭据确认的成员移除或设备吊销后，依次：

1. 注销 protector；
2. 删除 remote；
3. 通过新的持久化 SDK 原语（E1）删除整个命名空间；
4. 按白皮书要求清除该工作区的本地明文。

**模式准入：** 现有的[模式准入](../packages/platform/AGENTS.md#e2ee-workspace-control)同样作用于引擎命名空间：

- 在经过认证的模式判定之前，不配置 remote。
- 有加密证据的工作区，在内容打开准入之前什么也不打开。
- 如果判定结果是加密或互相矛盾，临时的明文命名空间就退役，永不上传。这和现在临时 Repo 的处理相同。
- 引擎房间的加密策略在创建时固定，与 remote 不匹配的房间会被拒绝，所以不一致时会失败关闭。

**快照上传：** 沿用现在的加密策略：

- 只有可写设备上传；
- 空闲 30 秒且新增至少 1 MiB 时上传，达到 4 MiB 时强制上传；
- 设备关闭、失去访问权或处于 epoch 阶段时不上传。

这需要一个 SDK 钩子（S3）。

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

**二、引擎 socket。** socket 的权限是 0600，但每条连接都拥有完整 API，包括注册 protector 和配置 remote。同一 OS 用户下的任何进程本来就能读明文存储，所以本设计把 OS 用户当作边界，和现在一样。

差别在于，socket 是一个活的 API，而不只是文件。是否接受这一点，见开放问题 1。

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
| S1 | 云同步 | 按房间的实时订阅与拉取：`setRoomInterest(ns, rooms, {live})`、`syncRooms(ns, rooms)`。修正二进制 Loro-update 订阅，使它也计入订阅。 |
| S2 | 云同步 | token 回复携带 `{token, expiresAt?, baseUrl?, bucket?, shardUrls?}`，并在过期前刷新。加密内容 token 有效期 8 分钟，且自带 bucket。 |
| S3 | 云同步、E2EE | 每个 remote 的快照上传策略：`{debounceMs, minBytes, maxBytes}`，加上 `canUploadSnapshot(ns, room)` 反向 RPC，以及响应修复请求的 `uploadSnapshotNow(ns, room)`。快照字节必须与旧编码一致。 |
| S4 | 云同步 | 远端导入永远不被本地 `docSchema` 拒绝，schema 只约束本地 patch。先验证；验证不通过才补原语。 |
| E1 | E2EE | `dropNamespace(ns)`：排空、关闭，并持久删除命名空间的数据库和 outbox。 |
| E2 | E2EE | protector 按 writer 精确路由：带写入者的行永不回退到 `*` protector。需要验证并补测试；API 已有 `writers` 字段。 |
| N1 | — | socket 的按连接权限范围（限定命名空间、只读）。只有开放问题 1 选"加固"时才需要。 |
| N2 | — | 用流式实时传输（SSE 或 WebSocket）代替 long-poll。 |

npm 发布版必须包含发布构建用到的全部原语。0.1.0 早于其中大部分原语。

## 分阶段计划

行数是 Lody 产品代码的粗略估计，不含 SDK。

| 阶段 | 范围 | 验收 | 回滚 | 行数 |
| ---- | ---- | ---- | ---- | ---- |
| 0 | 证明格式一致；S1–S4、E1、E2 合入并发版。 | 双向互通向量，覆盖明文和加密的 update、快照、Flock bundle，以及服务端写入的帧。 | 不涉及。 | 约 300（测试） |
| 1 | 云端组合里的同步核心：准入后配置 remote、token provider、实时订阅、接管旧存储、终止时排空。先用于**加密**工作区（见开放问题 2），用独立开关控制。 | 私有仓库 E2E 加入 native 设备：persistence、snapshots、recovery、collaboration、canary 明文外泄审计；layer-B 的 `skew-convex-slow`、`transient-503`；native 桌面与 JS Web 设备混合。 | 关闭开关：旧存储从云端重新同步，未上传的行回写。 | 约 1800 |
| 2 | 普通云工作区复用同一核心。 | 打开 native 跑 CLOUDSYNC-001 和 cloud journey；layer-B 的 WAN 配置；W6 时钟偏差；关闭后再打开开关。 | 同阶段 1。 | 约 600 |
| 3 | 观察期后默认打开，再删除桌面和 daemon 的旧路径。Web 和手机不变。 | 完整的 `verify:release`。 | 回退发布。 | 净减少 |

阶段 1 和 2 的先后顺序见开放问题 2。私有仓库的测试工具目前还没有 native 设备角色，阶段 1 需要补上。

## 待 owner 决定的问题

1. **加密工作区里的引擎 socket。**
   - **背景：** 同一 OS 用户下的任何进程都能调用宿主的完整 API，包括注册一个更高优先级的 protector 来查看明文。不过它本来就能读明文文件。
   - **选项：**
     - (a) 和现在一样，以 OS 用户为边界，零成本；
     - (b) 增加按连接的权限范围（N1）和连接认证，需要 SDK 工作，会推迟阶段 1。
   - **推荐：** 本设计选 (a)，等处理白皮书里"本地连接保护"那一项时再重新评估。
2. **上线顺序。**
   - **背景：** 加密工作区没有生产数据，并且将成为默认；普通云工作区有现有用户。
   - **选项：**
     - (a) 先上加密工作区：影响面最小，也直接验证 E2EE 优先的设计；
     - (b) 先上普通云工作区：更简单，但新路径的第一批用户就是生产用户。
   - **推荐：** (a)。
3. **内容加解密在哪里运行。**
   - **背景：** SDK 提供引擎内置的 Rust keyring，可以省掉反向 RPC 这一跳。代价是托管方要把 epoch 密钥导出到引擎进程，而 core 禁止这种导出；core 的每项检查也都要再实现一遍。
   - **选项：**
     - (a) core 留在托管进程里（决定 5）；
     - (b) 使用 Rust keyring。
   - **推荐：** (a)。阶段 0 实测反向 RPC 的开销。

## 依据

- **意图：** 协调会话于 2026-11-20 转达的 owner 方向：E2EE 优先、Roost 将成默认、权限本地验证、不改格式、可用性优先。本修订尚未批准。
- **已检查：**
  - native 实现栈：draft PR #2902–#2942（顶层 `native-desktop-acceptance-fixes` @ `840f6d05`），及其设计文档 `.agents/docs/native-workspace-meta.md`；
  - loro-dev/loro-repo `main` @ `ad97aa3`：`rust/packages/client` 中的 remote、protector、auth、status 类型，`rust/docs/architecture.md`，以及 `lody-routes` 路由表；
  - [Workspace Streams 内容边界](workspace-streams-content.zh.md)、[E2EE 基础](e2ee-foundations.zh.md)、[白皮书](e2ee/whitepaper.zh.md)、[平台 E2EE 规则](../packages/platform/AGENTS.md#e2ee-workspace-control)、[core 不变量](../packages/e2ee-core/INVARIANTS.md)、[客户端规则](../packages/e2ee-client/AGENTS.md)、[bootstrap 指南](../.agents/docs/e2ee-workspace-bootstrap.zh.md)。
- **未执行：** 尚未运行任何验证。SDK 内部只用它自己重新实现的 content-v0 测过字节一致，没有对 `@lody/e2ee-core` 测过。阶段 0 补上这个缺口。
- **后端：** 只属于后端的细节放在私有仓库的设计文档里。

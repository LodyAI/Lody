# E2EE Effect API 改造与验收

Status: proposed
Translation: current

[English](2026-09-22-e2ee-effect-api.md)

## 摘要

本轮按已确认的计划，将现役 E2EE 模块迁移到纯计算、Effect 流程、平台实现三层。
目的不是保证网络调用永不失败，而是让错误参数不能混用、预期失败显式返回、
持久化与重试顺序由客户端拥有。协议、磁盘格式及权限规则保持不变。
尚未完成的阶段不得宣称验收通过；这不是产品 E2EE 上线。

## 范围与约束

- 基线：`d7d3b7c6c0e150678eb8d4d0a1f1bd675655dc69`；Effect 3.18.4。
- 允许实验性 API 变更；迁移现役消费者。JSON/hex 原型隔离，不重写第二套实现。
- 公钥/签名/哈希/记录采用受检不透明类型；字节在边界复制。
- 纯函数返回值或 Either；流程返回具有具体错误通道的 Effect；平台拥有副作用。
- 当前非恢复设备均可转发当前代次密钥；发钥不授予管理、写入或背书权限。
- 保留精确 pending-before-CAS、冲突不重签、候选密钥恢复、快照原始租约及历史有效性。
- 不新增跨流事务、不变更可信快照模型、不启用生产 E2EE。

此计划替代 [Lab 历史计划](../testing/2026-09-16-e2ee-adversarial-lab.zh.md)
中保留公共 Promise API 的约束；其攻击场景与协议安全验收仍有效。

## 阶段追踪

| 阶段          | 状态     | 交付与闸门                                                       |
| ------------- | -------- | ---------------------------------------------------------------- |
| P0 契约与基线 | 完成     | 清点导出/消费者、冻结旧数据与验收；不改变协议                    |
| P1 纯计算层   | 完成     | schema、权限、证明、快照、content-frame、recovery-file 与重放 apply 均为 Either |
| P2 账本流程   | 完成     | 原生 verify/extend/snapshot/submit。本地 `create` 签署创世；远端发布与密钥备份仍由应用组合 |
| P3 其它模块   | 完成     | Lab 发钥/接收、快照准入、身份、内容 workflow、用户恢复 Effect。Promise SDK 已列出 |
| P4 迁移收尾   | 完成     | 协议桥已消除。剩余 Promise 面是列出的 SDK/IPC 解包，不是第二套算法 |

## 验收

### 剩余实现（不是等待新的产品决策）

- [x] 完成 P1：schema、crypto、policy、snapshot 校验改为无预期抛错的函数；
      保持内部重放更新高效，不在每条记录上复制完整状态。
- [x] 完成 P2：原生 verify/extend/snapshot/submit 与意图 `create`。初代密钥
      持久化与远端发布仍由应用组合，不是客户端内第二套 Org 创建算法。
- [x] P3：Lab 发钥/接收已用绑定投递+outbox，且先持久化再安装。
      快照准入共用一条 workflow。内容 parse/seal/open 为 Either/Effect；
      `ContentCipher` 与 streams-crdt 仍是列出的 Promise SDK 解包。用户恢复在
      `UserIdentityStore` 上。
- [x] P4：Lab host/content-session/backup 与 Electron device/user 服务在
      Promise SDK/IPC 边界组合这些流程。协议桥已消除（`--complete` 为 0）。
      裸攻击输入留在审计/测试边界。
- [x] 四类 1000 条闸门（3 次预热 / 10 次测量，Node v24.21.0）：完整重放中位
      1140 ms（低于此前约 1215–1268 ms 基线），增量 extend(+1) 1.76 ms，
      快照加入 156 ms，journal 恢复+验证 1148 ms。重放无超过 20% 回退。
      10k/100ms 仍撤销。根目录 `pnpm check` 现已通过。没有协议或产品启用。

- 编译拒绝错钥类型、未验证记录、非法设备管理标记及未穷尽分支。
- 普通客户端不拼接签名、parent、nonce 或 CAS offset；公共错误不能为 unknown。
- 验证结果绑定实际视图；不接受同 head 不同认证状态、跨 Org 或失效授权。
- 对输入/输出数组的修改不得改变内部状态。构造 Effect 不做 I/O。
- CAS/存储/回读各边界故障不丢 pending、不重新签名或生成候选密钥。
- 旧记录、journal、信封、备份可读取；真实密码学和 Lab 裁判不降级。
- 固定 1000 条记录、预热后 10 次同机对比；中位耗时回退超过 20% 须解决。
- 完成时跑类型检查、core/Lab 测试、文档/导入边界检查；10k/100ms 目标仍撤销。

## 工作日志（追加）

### 2026-09-22 — 开始

- HEAD 与计划基线一致；现有未跟踪的研究文档、Agent 配置原样保留。
- 文档状态检查无错误（37 项既有大小警告）。
- 现役导出闭包包含 ledger、content、streams-content、snapshot-admission、
  recovery-file/device、user-identity 及其 Node 存储。消费者为 core 测试/bench、
  Lab 与 Electron 的 device/user 服务。
- 此日志中的未完成阶段不是已验证保证；后续追加实际命令、结果和提交。

### 2026-09-22 — P0 基线执行

- core `node node_modules/vitest/vitest.mjs run`：35 文件，405/405 通过，含真实
  10k journal 持久化/重启测试（约 137 秒）。
- `pnpm check`：全仓类型检查通过；lint 在 Lab 的原有 9 个错误处停止，
  后续测试/边界检查未运行。涉及 minimize、driver、repro-pack、attack-lab。
- P1 已开始不透明字节类型、具体错误与 Either CBOR；现役入口未改，尚未验收。

### 2026-09-22 — P1 基础切片

- 私有构造器和边界字节复制区分签名/加密公钥、签名、创世/记录哈希、成员/申请/用户 ID
  及代次。Brand 不替代校验；已验证记录与视图持有私有状态。
- CBOR 改为单一 Either 实现，`ledger/cbor.ts` 暂时为旧协议调用方解包，并非第二套编码器。
  提取共享兼容错误，使平台实现无需引用 JSON/hex 协议。
- 编译负例拒绝错钥、裸字节、伪造验证标记及 machine/recovery 管理标记。
  查看状态只返回副本。
- 这不是完整 P1：schema、crypto、policy、snapshot 校验仍须迁移为无预期抛错的函数。
  新流程通过明确的临时错误桥接接入，不能宣称旧 throw 已消失。
- 同一份 1000 条记录：基线重放中位数 1233.40 ms，首轮 CBOR 迁移后 1260.15 ms
  （+2.2%，预热 3 次、测量 10 次）。尚未满足增量/快照/恢复的性能验收。

### 2026-09-22 — P2 账本纵向切片

- 基础提交 `2ee49a54`；基线/计划提交 `8279a396`。
- `./effect` 提供绑定 Org、签名器和 journal 的意图客户端，返回明确的
  Committed/Conflict/Pending/Unsupported/Idle。先检查证明与权限，再请求签名。
  `resume` 拒绝其它签名设备的 pending。旧 Promise API 委托唯一的
  `workflows/ledger-engine.ts`，不维护第二套 CAS 状态机。
- 平台锁适配器接管旧回调事务的生命周期，不在内部启动 Effect runtime。
  保存与释放锁可承受取消；没有把 SQLite 同步事务改为异步事务。
- 缓存绑定持久化记录精确前缀与 snapshot/trust 原文；同 head 也不允许替换已经
  观察到的状态，只验证增量。不透明验证阶段将应用结果绑定到具体视图。
- core 完整检查：38 文件 / 426 项通过，含真实 10k 持久化、验签、旧格式、快照攻击
  和跨进程恢复。之后的签名设备绑定/参数捕获改动：类型检查、18 项原生客户端及
  11 项快照客户端测试通过。完整测试运行早于最后这两项新增。
- Lab 完整检查：18 文件 / 135 项通过。首轮发现 Streams 错误码丢失，已修适配器，
  未修改裁判。非法页以 StreamProtocolError 失败，不伪装 Pending；程序缺陷仍是缺陷。
- 在 pending 保存/清除前后四处确定性注入取消；重开存储后确认只有原记录，不重签。
- 同机同一份 1000 条记录复测：基线中位数 1214.85 ms，当前 1235.57 ms
  （+1.7%，各预热 3 次、测量 10 次）。其它性能闸门仍未通过。
- `pnpm check` 再次通过全仓类型检查，随后仍被既有 9 个 Lab lint 错误阻断，
  后续阶段未执行。本轮代码定向 lint 无错误；仅格式化本任务文件。
- `check:effect-boundaries` 使用 TypeScript AST 检查已迁移层的导入、显式 throw、
  隐式环境调用及 runtime 启动，明确报告 9 个临时协议桥接；`--complete` 会拒绝该状态。
- **P0–P4 尚未完成**。内容/密钥/恢复的原生 API 和消费者迁移是剩余实现工作，
  不是等待人工审批的 blocker。产品 E2EE 仍未启用。

### 2026-09-22 — 源码风格约束

- 在 core 与 Lab 的 `AGENTS.md` 中加入相同的强制约束：完全纯的计算层、通过
  Service 隔离副作用的 Effect 流程层、薄平台 Layer；复杂度优先集中于 pure，
  其次 workflows；追踪与日志同样通过 Effect 表达。
- 预期失败不得 throw；非预期致命缺陷保留独立语义。现有迁移例外只是临时桥接，
  不代表代码已经完全满足纯度要求。
- 两包已使用工作区精确锁定的 Effect v3 `3.18.4`，本次不改依赖或运行行为。

### 2026-09-22 — P1 纯权限计算

- 创世及全部七种普通操作的权限计算已迁入 `pure/ledger-policy.ts`，返回类型明确的
  Either，不修改输入，不使用签名缓存、I/O 或隐式时钟。编码和权限规则保持不变。
- 临时旧接口适配器只在完整检查成功后，将内部变更立即应用到自己持有的重放状态；
  失败不应用任何变更。该变更不是公开授权凭证，不能绕过证明校验，也不会每条复制历史。
- 状态工具迁入 `pure/ledger-state.ts`；分叉状态会复制成员、设备、创世及历史字节。
  标识符格式化统一由纯实现提供，兼容入口不再重复实现。
- 新增行为测试覆盖确定性、输入不变、后续密钥检查失败不消费签名公钥、修改返回变更、
  防重放和分叉字节隔离。core 全量通过：38 文件 / 430 项，包含真实 10k journal 和
  跨进程恢复。类型检查、定向 lint、分层检查、文档检查通过（原有 37 条文档警告）。
- P1 仍未完成：schema/crypto/证明/快照转换及可变重放适配器仍需收尾；9 个 workflow
  协议桥接尚在，本轮未增加例外。P2–P4 和重放之外的性能验收仍待完成。
- 同机同一份 1,000 条记录、两版链头与完整权限状态一致；各预热 3 次、交错测量
  10 次，重放中位数为基线 1268.49 ms、本次 1453.48 ms（+14.6%）。未超过 20%
  门槛；基线权限源码 SHA-256 与 `d7d3b7c6` 一致，其它性能闸门仍开放。
- 全仓 `pnpm check` 通过所有类型检查，lint 报告既有 Lab 错误及一处新增的穷尽分支
  返回问题。后者已通过接受 `never` 的兜底分支修复，未禁用规则；最后改动后的定向
  类型感知 lint 和五项权限/验证测试通过。430 项全量运行早于该兜底改动；剩余根目录
  lint 错误不是完成验收的豁免。

### 2026-09-22 — P1 Either schema 与显式校验事实

- 记录编解码和签名消息构造的唯一实现迁入 `pure/ledger-schema.ts`；旧 schema 函数
  只为旧入口解包结果。字段/哈希/代次原语迁入 `pure/wire-crypto.ts`，旧原语接口委托
  新实现。签名执行、证明和快照流程仍待迁移。
- 原生 workflow 直接消费 schema 的 Either 返回值，检查清单减少三处桥接（9 → 6），
  没有增加例外或线格式字段。
- 初次迁移因重复点校验失去复用，造成重放 +63.0% 回退。新增不可变 `SigningFacts`，
  由纯解码显式接收并返回。它只证明公钥点合法，不证明签名、成员或权限。临时旧缓存
  在边界负责有界替换这些事实，纯函数不修改输入或事实；权限层复用同一校验结果。
- 同一份 1,000 条记录、预热 3 次、交错测量各 10 次：基线中位 1216.16 ms，当前
  1232.65 ms（+1.36%），完整状态和链头一致。修复了此次回退，但增量/快照/恢复的
  性能验收仍未完成。
- core `pnpm check` 通过：类型检查、分层检查、38 文件 / 432 项测试。定向类型感知
  lint 无错误；新增字节/校验事实隔离及非法点测试。随后添加的纯编译负例拒绝结构伪造
  校验事实，类型检查通过。P0–P4 尚未完成，旧重放/签名适配器和现役消费者仍待迁移，
  不能作为最终架构验收。
- Lab `pnpm check` 也通过：类型检查和 18 文件 / 135 项，含持续协作、恶意后端探针、
  进程崩溃及无模型重放。未降低裁判预期；全仓收尾验收仍待完成。

### 2026-09-22 — P1 证明消息的所有权

- 加入/设备持钥证明的消息构造统一到纯 `operationProofJobs`，返回 Either 并持有字节
  副本。串行重放和批量加入证明复用它；设备证明仍在已知前置成员实例的重放阶段验证。
- 设备目标缺失返回 unauthorized。真实签名测试确认：替换目标成员会使证明失效；
  构造后修改输入公钥、签名或 genesis 不会改变已经构造的验签任务。
- 类型检查、分层检查和定向类型感知 lint 通过。账本/向量/矩阵选择集 19 项通过，
  随后的验证/执行器边界选择集 14 项通过。本轮未重跑全量；签名执行和快照迁移仍待
  完成，没有新增权限或协议字段。

### 2026-09-22 — 快照纯计算与显式验签 Service

- 将快照编码、规范/结构校验、状态导入和对账移到 `pure/ledger-snapshot.ts`，失败返回
  Either；旧入口仅委托，线格式和背书权限不变。真实签名回归确认：结构合法但签名
  伪造的快照仍被可信验证流程拒绝；解析持有字节副本，不会制造可信状态。
- 单条记录验签及加入证明构造现在要求 `SignatureVerifier`。platform Layer 在获取时
  建立独立缓存，workflow 不能隐式使用全局默认。编译负例拒绝未提供 Service 的运行；
  真实密钥测试覆盖延迟执行前修改输入、另一设备代签，后者仍返回 bad-proof。
  Service 是应用信任的依赖，不是攻击者提供的背书。
- workflow 协议桥接剩 4 处。platform 适配器仍委托旧严格 Ed25519 实现，包含旧哈希
  配置，尚非原生密码实现迁移完成；整账本重放也仍使用旧验证器。
- core `pnpm check`：38 文件 / 435 项通过，含 10k 持久账本与跨进程恢复；Lab
  `pnpm check`：18 文件 / 135 项通过。这两次全量早于最后的加入证明 Service 改动；
  该改动之后类型检查、分层检查、定向类型感知 lint 和 Effect 客户端/类型/验签选择集
  30 项通过。全仓检查与剩余性能门槛仍待完成。
- 当前是 e2448e49 上的未提交改动，不是 P1/P2 完整验收或产品启用。继续原生重放/
  密码适配与 P2 创建/存储生命周期，再迁移全部 P3/P4 消费者，不能用局部通过替代终验。

### 2026-09-22 — 按意图创建本地创世账本

- `LedgerClient.create` 现在接收 `CreateLedgerCommand`：不透明用户/成员 ID、加密公钥
  及独立类型 EpochCommitment。模块负责锁定输入字段、签名、编码、计算 anchor 和验证
  后创建 journal。原始创世字节入口显式命名为 `importGenesis`，用于导入/审计。
- 真实密钥测试与原有 fixture 对比完整记录及 anchor，重新打开 journal，并确认错误
  签名不会持久化。创建本地 journal 不等于发布 genesis，也不证明初代密钥已持久备份；
  P2/P3 仍需组合生命周期。未改变 journal/线格式，不能替代完整 Org 接入验收。
- 修复签名适配器的延迟字节所有权：构造 Effect 时复制，每次执行再提供独立副本。
  真实确定性签名测试修改原数组并重复执行，两次均得到原始预期签名。
- 引擎哈希改用纯计算，workflow 协议桥接剩 3 处。类型检查、分层检查、定向 lint
  （0 错误 / 1 警告）及 Effect/客户端/向量 34 项通过；最终改动未声称全量或性能通过。
  当前仍是 e2448e49 上的未提交工作，完整 P0–P4 目标继续进行。

### 2026-09-22 — 纯 journal 编解码与显式 Node 数据库生命周期

- v0/v1 journal 编解码迁到 `pure/journal-codec.ts`，返回类型化 Either，没有 Buffer
  或 Node 导入；旧 Node 入口只委托，不保留第二套算法。冻结持久化字符串往返不变；
  结构解析仍不证明账本可信，也不授予权限。
- 新增 Node-only 的 `./effect/platform-node`，提供 `nodeJournalStoreLayer({path, mode})`。
  create 排他创建文件；open 只打开已有、格式符合要求的 SQLite，不初始化空白/外来
  文件；后续每次事务仍保持禁止自动创建。缺失、已存在、损坏、外来、占用明确区分。
  创建失败可能留下文件，不自动删除或重建。目录由应用管理，不承诺对抗并发恶意本地
  文件系统操作。
- 共享 SQLite 机制仅为尚未迁移的调用保留旧默认。显式 Layer 仍经过 Promise 事务
  适配器；替换该适配器与迁移所有调用仍待完成，不能据此提前验收。
- 客户端/存储 31 项及共享存储/历史/恢复 80 项通过。覆盖真实 SQLite 锁占用、释放后
  重开、Layer 获取后文件删除、缺失文件 open、外来/损坏文件原样保留和既有进程崩溃
  恢复。类型、纯层边界、定向类型感知 lint（0 错误）、公共边界（5098 文件 / 23
  manifests）、diff 和文档检查通过；文档保留 37 项警告。全仓及性能门槛仍待完成。

### 2026-09-22 — Effect 直接管理同步 SQLite lease

- 共享 SQLite 实现拆为同步 `openExclusive` lease 和委托它的旧 Promise 包装。Node
  JournalStore 直接使用 `Effect.acquireUseRelease`、纯 journal codec 与同步读写，
  不再通过 Promise 回调交接锁；没有内嵌 runtime，也没有异步 SQLite 事务。每次 save
  仍独立提交，后续失败不能回滚可能已发送远端的持久字节。
- 中断/缺陷测试确认释放锁、保留已保存 pending，并拒绝使用已释放事务。原生
  LedgerClient 还通过真实数据库集成测试：创建、false-ACK Pending 落盘、禁用签名后
  重新打开、按原字节 resume，并仅在回读确认后清 pending。
- 最后集成测试前，SQLite/存储/恢复 78 项通过；添加它之后 journal 13 项通过。
  类型、分层检查及此前定向 lint 通过。通用 Promise 适配器仍服务未迁移消费者，共享
  旧错误边界也尚未全部转换。不能据此认定完整 P0–P4 或性能验收通过；改动仍未提交，
  基线为 e2448e49。

### 2026-09-22 — P3 密钥信封/历史的纯计算

- 转发权限、持有副本的接收者公钥查询、AAD、签名域组帧及解析统一到纯 Either 函数，
  旧 HPKE 入口委托它们。Guest/machine 可转发、恢复设备仅接收的规则不变。解析持有
  密文和签名字节，不代表签名或密钥已被验证。
- 历史加密显式接收 nonce，熵源留在纯层外。历史包收集、解密及完整链承诺检查共享
  纯实现。格式/域/算法不变；缺失或损坏的链路必须失败，不能跳过。
- 真实密码测试覆盖返回值所有权、非法 nonce 长度、损坏历史以及格式合法的伪造签名。
  密钥/进程恢复选择集 15 项通过，最终密钥/快照/向量 32 项通过。类型和分层检查通过，
  定向 lint 为 0 错误 / 4 警告；没有新增全量或性能验收结论。
- P3 仍为部分完成：HPKE 和熵源仍在旧入口运行；发钥保留 unknown 错误通道、通用
  授权回调及宽泛捕获。后续用绑定接收者/当前视图的流程与类型化 Service 替代，保留
 精确信封重试和发送前授权重查。

### 2026-09-22 — HPKE platform Service 与不透明代次密钥

- HPKE SDK 构造、句柄和 WebCrypto 调用移入同一个 platform driver，由旧入口及
  原生 HpkeSender/HpkeRecipient Layer 共享。构造 Service 描述不执行密码操作，
  由 Layer 获取和 Effect 执行负责；延迟执行前复制输入字节。接收端私钥句柄不进入
  pure，也不暴露在 Service 接口中。
- EpochKey 使用私有字节，不提供公开导出方法，与 EpochCommitment 类型不同。
  只有包内密码/持久化边界能获得临时副本。这是防误用边界，不是 JavaScript 沙箱。
- 已知 HPKE/DOM 失败转为 CryptoError，意外熵源缺陷保持 defect。真实固定熵源 HPKE
  与旧信封密文一致，能解密并重新加密、拒绝篡改，且不受输入数组后续修改影响。
  编译负例覆盖将承诺冒充密钥、直接导出密钥字节。
- 密钥/类型/进程恢复 21 项通过后，收紧密钥封装；最终密钥/类型 16 项通过。类型和
  分层检查通过，此前定向 lint 为 0 错误 / 4 警告。P3 尚未完成：绑定当前视图与承诺
  的信封流程、熵源 Service、持久 outbox 及其余生命周期仍须迁移。无协议或产品启用变更。

### 2026-09-22 — 绑定账本的信封流程与显式原生熵源

- 原生 LedgerClient 准备/打开信封时先刷新已验证视图，自行查询接收者加密公钥并
  核对当前密钥承诺。异步密码操作后再次刷新，拒绝相关撤权和换代；无关账本推进
  不必使操作失效。
- PreparedEpochEnvelope 持有自己的密文字节，合法类型调用不能自行拼造。Prepared
  不等于已保存或送达，打开得到的 EpochKey 不等于已安装。线格式、签名和 HPKE
  信封保持互通。
- 原生 HpkeSender 必须注入 CryptoEntropy；生产显式组合 WebCrypto Layer，测试
  注入自己的 Layer。每次执行才取新随机字节，构造时不取。错误长度为类型化 generate
  失败，意外缺陷保持 defect；旧入口暂时保留熵源适配器。
- ledger-keys、effect-types、effect-client 和双进程恢复共 43 项通过；类型检查、
  定向 lint 通过（0 错误/警告）。分层检查通过，仍有原先 3 个协议桥。测试覆盖真实
  密码操作、伪造签名、错误密钥/接收句柄、签名或解密期间撤权、延迟输入所有权，
  以及每次取新熵后产生不同密文。
- 改动仍未提交，基线 e2448e49。P3 尚未完成：发钥队列还有通用授权回调和 unknown/
  宽泛捕获错误。下一步迁移持久精确信封队列及发送前重查，恢复时不能重新加密。
  本次不宣称全量测试、性能或 P0–P4 验收完成。

### 2026-09-22 — 共享的类型化发钥队列流程

- 发钥 ID 校验、精确信封选择和回读比较移入 pure；workflow 通过 KeyOutbox/
  KeyDeliveryRemote Service 完成先保存、两次授权及回读。旧发钥入口委托同一实现，
  删除手写 abort 竞争和 unknown 公共错误通道。
- 只有类型化 TransportError 能变成 Pending。协议拒绝和适配器缺陷继续传播；
  取消保留密文并释放锁。临时 Promise 存储适配器等待正在执行的存储操作结束后再
  释放锁，不启动内部 runtime、不改持久化格式。
- 构造时复制延迟输入；授权回调拿到副本，不能修改将要保存或发送的密文。测试核验
  实际字节、延迟非法 ID 失败，以及 put/read 缺陷与协议拒绝的区别。
- 发钥、SQLite journal 和原生客户端选择集 43 项通过；类型、定向 lint（0 错误/
  警告）和分层检查通过，仍有原有 3 个桥。最后锁/span 编辑复验：发钥 10 项、类型
  检查及定向 lint 均通过。
  绑定客户端的发钥授权入口、直接持久 outbox 组合仍待完成，不宣称 P3/P4 完成，
  本轮没有新提交。

### 2026-09-22 — 客户端绑定的发钥队列授权

- 已绑定客户端提供 deliverEpochEnvelope/resumeEpochDelivery，调用方不再提供授权
  回调。保存的信封须匹配客户端签名者、接收者和刷新后的 genesis/epoch，通过严格
  验签，再刷新重查。恢复不签名、不调用 HPKE、不需要代次密钥；转发资格仍不等于
  管理权限。
- DeliveryId 使用独立受检不透明类型，不复用加入申请 RequestId。信封和 outbox
  格式不变。Observed 证明精确回读，不证明安装或全球新鲜度。显式 prepare/deliver
  仍不是最终接管 ID/密钥准备与持久化的单意图生命周期。
- 真实密码测试覆盖无 HPKE 依赖的 Pending→Observed、替换接收者、替换发送者、
  换代和设备撤权；编译负例区分加入与发钥 ID。修正测试 fixture 的历史加密调用后，
  类型检查和密钥/发钥/类型共 28 项测试通过。定向 lint、分层检查在此前仅 fixture
  错误的版本也已通过。
- 剩余：直接原生持久 outbox、完整单意图发钥生命周期、其余 P3 模块和 P4 消费者/
  检查。改动尚未提交，基线 e2448e49。

### 2026-09-22 — 直接原生 SQLite 发钥队列

- nodeKeyOutboxLayer 显式区分 create/open，通过 Effect.acquireUseRelease 直接
  持有同步 SQLite 锁，不经过 Promise 事务桥。打开缺失、外来或损坏文件会失败，
  不初始化；创建使用独占文件创建。每次保存独立持久化，后续失败或取消不回滚，
  关闭连接释放系统锁。
- 原有 v0 payload 编码迁为纯 Either 计算，新旧 store 共享实现，格式不变。
  精确信封选择拒绝替换已保存内容，保留大小限制、规范行和重复拒绝。领域/编码
  判断留在纯层，不放进平台包装。
- 最终 SQLite/发钥 27 项通过，包括新旧双向互读、固定字节、非规范/重复/未知版本
  输入、缺失/外来/损坏文件，以及持久保存后的显式取消。类型和定向 lint 通过
  （0 错误/警告）；最后仅添加测试前分层检查通过，仍有原先 3 个过渡桥。
- 不代表整份计划通过：单意图发钥生命周期、其余 P3 模块、消费者迁移及完整性能/
  检查仍待完成。本轮未提交。

### 2026-09-22 — 单意图的当前密钥发送

- sendEpochKey(recipient, key) 通过同一发钥引擎接管准备/保存/发送/回读。规范编码
  的 genesis/epoch/sender/recipient 经域分隔哈希得到稳定 16 字节本地幂等位置。
  不改变签名信封或 outbox 持久化格式，ID 从来不证明权限。显式 prepared 发送留作
  高级边界，不作为普通示例路径。
- outbox 锁内优先使用已保存字节，只有不存在时才执行 HPKE。准备不能漂移到不同于
  已选位置的代次。重复和并发调用重查权限/签名，不替换原信封。保存前无远端副作用；
  结果返回 DeliveryId，供后续不带代次密钥恢复。
- 真实集成测试覆盖换客户端实例后的 Pending→Observed、持久密文不变、重试 Layer
  禁止执行 HPKE、输出能解密，以及并发重复发送。密钥/发钥/SQLite 41 项通过；类型、
  定向 lint 和分层检查通过。core 全量检查结果见后续记录。
- 剩余：密钥来源和安装存储、其余 P3 生命周期、P4 消费者迁移及完整验收/性能。
  不启用产品 E2EE。
- 包内完整 `pnpm check` 已完成：类型、分层检查（3 个已声明桥）、38 文件 / 458 项
  测试通过。万条持久链测试属于功能覆盖，不代表恢复性能目标。根工作区和 P4 验收
  仍待完成。

### 2026-09-22 — 共享纯轮换绑定暴露 Lab 上下文错误

- 候选分类从 Lab platform 移入 core 纯查询，通过已验证 Ledger/LedgerView 使用。
  检查密钥/承诺、publishEpoch 字段以及精确签名记录确实存在，才判当前或历史。
  历史成功不改变当前代次，尚未入链不代表能安装。
- 首次 Lab 生命周期 29 项中 10 项失败：DemoSession.genesis 保存的是创世签名
  记录全文，却被用于要求其哈希的代次承诺、历史 AEAD 和信封 AAD。原有内部往返
  两边都使用错误上下文，因此相互通过；core 查询揭露了这个差异。
- Lab 密钥调用改用已验证 ledger.state.genesis，回放/启动仍用创世记录。不改 core
  协议和持久化 schema。旧录制中绑定全文的承诺不能静默迁移或认可，也不能宣称
  这些旧 artifact 回放兼容；新录制须来自修正后的实现。
- core 密钥/快照 36 项、两个包类型检查通过；修正后 Lab 生命周期 29 项通过。
  另增加直接使用 Org 哈希通过 core 打开 Lab 信封的互通回归（最终复跑见下）。
  完整轮换 Service 编排、持久化和安装仍待迁移。
- 最终互通复验：Lab 类型检查和 29 项生命周期测试通过，文档及 diff 空白检查通过。
  不新增 core 全量或 Lab 全量通过结论。

### 2026-09-22 — 轮换迁移前置修复：错误传播与持久安装

- 提取剩余状态机前发现两个旧 Lab 生命周期风险：无法读取/非法的 pending journal
  被当作没有 pending，候选密钥在文件保存前已进入内存。先修复这些行为，避免把
  错误语义搬进原生 workflow。
- pending journal 读取/解析错误现在传播；提交不再将任意缺陷/存储错误转换成 unknown。
  已有 replay、wrong-parent 的显式处理保留，传输不确定性仍由共享账本引擎负责。
  这里仍是临时 Promise Lab 边界，不宣称其 throw 或全部 platform 编排已迁移。
- 候选安装先构造独立密钥表、持久化，之后才暴露到内存并清除候选。写盘失败保留
  原密钥表和候选；重试安装同一个已确认密钥，不再生成新一代。
- 生命周期 31 项及 Lab 类型检查通过；真实文件故障覆盖已提交未安装的恢复、损坏
  journal 拒绝。定向 lint：0 错误 / 25 警告。Lab 全量回归运行中，不提前宣称完成。
- 全量首先发现两个 design probe 仍向密钥 API 传创世记录全文；只修正上下文输入，
  保留权限和错误密钥拒绝断言。最终 Lab `pnpm check`：类型检查及 18 文件 / 137 项
  测试通过，包括独立回放和真实模型攻击记录。完整 Effect 迁移及根检查仍未完成。

### 2026-09-22 — 工作区闸门与 Lab 静态检查

- 工作区类型检查通过，包括现有 Electron 消费者；根检查随后在测试前停于 9 个
  既有 Lab lint 错误。修复未用导入、generator 返回一致性及闭包更新的循环预算判断，
  未关闭规则。ScheduleDriver 清理后显式选择调度器/工作错误，不再靠 finally 中
  throw 覆盖控制流。
- 根 lint 已通过：0 错误 / 11739 个既有警告。repro-pack、attack-lab、runtime-permit
  定向 36 项及 Lab 类型通过；增加缩减器零/一次预算和确定性调度失败优先级检查。
- P4 状态修正为“部分完成”，不再写“未开始”：Lab 共享策略和边界修复在推进，
  Promise 消费者和 platform 编排仍未迁移完。正在重跑根完整检查，不据此宣称完成。

### 2026-09-22 — 完整检查结果与轮换存储提取

- 根检查 exit 1：core 459 项、Lab 138 项通过，但 CLI 的
  `worktree-gc.test.ts` 期望 `/private/var/...`，实际收到 `/var/...`。
  此处不在本次迁移修改范围内，未修复或豁免；test:ci 之后串联的检查未执行，
  不能宣布根检查通过。
- 将候选 JSON 编解码提取到 core pure，保留五个 hex 字段、顺序和末尾换行。
  Lab 委托此实现；解析只证明结构、字节长度和正安全整数代次，
  不等于验签或获得安装密钥的权限。
- 磁盘读取失败不再冒充 JSON 损坏。生命周期测试检查原错误对象，且候选文件、
  账本代次和已安装密钥不变；格式损坏仍拒绝且不重新生成候选。
- 新增旧 JSON 字节兼容、解码数组独立性与非法字段测试。core 发钥套件 17 项、
  Lab 生命周期 31 项通过；两包类型检查和分层检查通过（仍有 3 个桥接）。
  原生轮换流程及存储 Service 仍未完成，Lab 的 Promise 边界仍是临时实现，
  不能据此宣称完整纯化。

### 2026-09-22 — 原生轮换与恢复流程

- 意图客户端新增 `rotateEpoch` / `resumeEpochRotation`，使用显式候选存储和
  只追加密钥存储 Service。账本引擎负责当前权限验证与签名；候选 JSON 必须先保存，
  再将精确记录提交 CAS。有候选时优先恢复，不生成新的密钥或签名。
- 只有精确记录进入已验证视图后才能安装。先持久化密钥，再删除候选；安装失败或
  被中断时保留恢复材料。历史安装不能改变当前代次，当前代次只来自账本，
  不依赖密钥存储中的可变 current 指针。
- pending 轮换缺少候选、文件损坏、候选不匹配分别返回类型化错误。
  Conflict 只清理被拒绝候选，Pending / Unsupported 保留候选；
  不把缺陷或中断转换成 Pending，使用不含秘密的 Effect span。
- 原生客户端套件 27 项通过，使用真实签名和确定性 Service，覆盖先保存后 CAS、
  保存失败、禁用随机源的 pending 重试、安装失败、删除候选前取消、并发恢复、
  候选缺失/损坏/不匹配以及历史恢复不回滚；类型检查通过。
  生产存储 Layer、Lab 消费者迁移及 P3/P4 其它门槛仍未完成，不宣布阶段或 goal 完成。

### 2026-09-22 — 本地轮换的原生文件存储

- 新增保留原格式的纯密钥文件编解码及只追加安装规则。重复代次、损坏密钥和替换
  既有不同密钥均拒绝；保留 JSON 行顺序和换行，文件存在不等于授权。
- `nodeEpochFilesLayer` 显式绑定 Org 并打开既有密钥数据，使用独立 SQLite 锁文件
  （不含密钥）、原子文件替换及文件/目录 fsync。不抢占旧锁，不靠超时解锁，
  不重建丢失的密钥文件；离开租约后的事务句柄拒绝继续使用。
- 这是本地 Lab 明文格式兼容适配器，不是生产 OS 保护存储。用真实签名和磁盘测试
  原生流程重开：无需随机源恢复 pending 候选，提交精确记录，安装密钥，清除候选
  及账本 pending。还验证缺失/损坏、重复/替换拒绝、独立句柄锁竞争、中断释放锁
  且保留已保存字节。Node 套件 20 项，与原生客户端共 47 项通过；类型检查、局部
  lint、分层检查通过。Lab 消费者尚未迁移，不宣称新的工作区全量验收通过。

### 2026-09-22 — Lab 轮换委托 core

- 删除 Lab 重复的候选生成、重试/核对、安装流程。Promise SDK 方法通过临时旧客户端
  Effect 桥接委托 core，不保留第二套轮换算法；完整原生会话迁移和移除临时入口仍待完成。
- 原生文件适配器接受显式故障注入 I/O；默认本地实现仍用原子替换/fsync，注入 LabFs
  是测试能力。保留原 `history-packet-nonce` 随机源标签，避免不必要的重放标签变化。
  Lab 加载损坏密钥文件不再悄悄重置为空 Map。
- 生命周期测试改为断言类型化 StorageError / PendingOperationExists，保留不提交、
  不安装、文件不变及后续恢复检查。其它 pending 阻挡新轮换时，不再旁生候选文件。
- 两包类型检查、局部 lint 和 38 项生命周期/协作/字节重放通过，包括新目录重放和
  跨进程恢复。下一步跑完整 Lab 检查；不据此宣称 P3/P4 或工作区全量验收完成。
- 随后完整 Lab 检查通过：类型检查及 18 文件 / 138 项，包括独立重放包与攻击场景。
  检查代码时发现新随机源适配器把重放标签错误归为通用 CryptoError；现只将
  DOMException 映射为 CryptoError，其它缺陷保留。新增测试检查原缺陷诊断、
  无候选且账本/密钥不变。最初的对象身份断言失败，因为 Effect span 注解可能复制
  Error；这里保证诊断信息，而非 JS 对象身份。正在重跑 Service 和 core 定向检查。
  最后这处错误分类修复后未重新运行完整 Lab 套件。
- 最终定向重跑通过：Lab Service 5 项、core 发钥/客户端/存储 64 项。
  局部 lint 与文档检查通过，未 commit 或 push。

### 2026-09-22 — 发钥流迁移前的拆帧基础

- 当前 Streams client 为 0.7.0，Lab 使用打包保留的 streams-crdt。发钥流存的是
  原始规范 CBOR AAD + HPKE + 签名信封，不是旧 StreamsKeyDeliveryRemote 的帧格式。
  直接复用旧适配器会改线格式；迁移必须保留这些字节与不透明 offset。
- 新增纯增量拆帧和未验证投递 ID 路由，跨页保留半截头部/密文，返回独立字节副本；
  不验签、不推断权限。替换 Lab 场景的手写 CBOR 遍历器，后者把每页当作完整帧，
  且读取截断整数时会补零。
- 枚举全部切分点的测试起初超过 5 秒，因为路由复用了含曲线验证的 SigningPublicKey
  构造器。现将未验证路由字节与已验证公钥类型分离，不加超时、不削弱实际信封验签；
  同一测试本机约 1.2 秒完成。
- core 发钥 19 项、完整协作/重放场景 4 项、两包类型及分层检查通过。
  Lab 发钥/outbox 消费者仍待迁移；本轮是保留原线格式的必要基础，非发钥迁移或
  P0–P4 完成。

### 2026-09-22 — 原始发钥流 workflow

- 新增明确的 EpochStream Service 与 KeyDeliveryRemote Layer，保持原始信封格式。
  按不透明游标跨页拼帧，限制页数和总字节数；拒绝尾部截断、游标循环和同一投递槽位
  的不同字节。找到匹配前缀不能跳过剩余流检查。
- 写入先对比已观察的精确字节，再 CAS；竞争是业务结果，不是网络异常。
  既有 outbox 通过回读确认，不重新封装。路由 ID 和远端观察不赋予签名或权限保证。
- 首轮 core 类型检查与 13 项投递测试通过。收紧 CAS 返回类型后继续复验；SDK 平台
  适配器和 Lab 消费者迁移尚未完成，不宣称端到端迁移或 P0–P4 完成。
- 最终复验：core/Lab 类型检查、13 项投递测试、分层检查通过（仍有 3 处既有协议桥）。
  已运行文档与 diff 检查；本轮未运行整个工作区检查，未 commit/push。

### 2026-09-22 — SDK 发钥流平台适配器

- 新增 `streamsEpochLayer`，使用应用显式选择的 StreamsClient，不自动创建流、不改线格式、
  不回退到普通 append。读取取消传入 SDK signal；append 保留精确字节副本（SDK CAS 无 signal）。
  鉴权/协议错误不变成 Pending；临时传输错误保持类型化。不把服务端正文或消息写进错误信息，
  意外的 SDK Promise 拒绝保留为 defect。
- 用真实 SDK 和确定性 HTTP 对端测试。新增 mismatch fixture 起初缺少
  `Stream-CAS-Mismatch: true`，SDK 正确将普通 409 当作一般冲突；按真实协议修正 fixture，
  未削弱适配器。最终 51 项流/投递测试、core/Lab 类型检查和局部 lint 通过。
- 下一步将此 Layer 与持久 outbox 接入 Lab 发钥生命周期。旧发钥路径和 P0–P4 全部门禁仍未完成。

### 2026-09-22 — Lab 发钥闭环

- `sendCurrentEpochKey(recipient)` 从 EpochKeyring 取当前密钥，从验证视图取接收者加密公钥。
  调用方只给接收设备身份，不传 `recipientEncryptionKey`。`receiveEpochKey` 先验签再
  `EpochKeyring.put`，然后才报告 Installed。持久化失败保留原密钥表。投递结果是
  Observed 或 Pending 加上精确帧；Observed 不等于安装完成。
- Lab `DemoSession.deliverEpochKey` / `receiveEpochKey` 组合 `streamsEpochLayer`、
  `epochStreamDeliveryLayer` 和 `nodeKeyOutboxLayer`。该路径已去掉直接 `appendCas`
  和调用方提供的接收者加密公钥。`sealEpochEnvelope` 只留在审计/测试边界（design probes）。
- 证据，未提交于 `e2448e49`：core 类型检查；32 项密钥/投递测试；Lab host-lifecycle 34、
  design-probes 25、collab-baseline 1（共 60）含重启不重加密、接收端先持久化失败、
  Pending 后再 Observed、Guest 转发和错误密钥拒绝。分层检查仍报告 3 处协议桥。
  未跑根目录 `pnpm check`，未 commit/push。
- 快照准入：offset/租约/身份/写权判定迁入 `pure/snapshot-admission.ts`；
  `workflows/snapshot-admission.ts` 在锁外验签、锁内重查。Promise
  `createContentSnapshotPublication` 是该唯一算法的宿主/SDK 边界。注入的 SQLite
  写失败仍是 defect，不会改成 `snapshot-store-corrupt`。快照套件 21 项通过。
  `deviceMayWriteDocument` 现位于 pure。ContentCipher 和 streams-crdt provider
  仍是 Promise。P0–P4 尚未完成。

### 2026-09-22 — 设备/用户身份 Effect 存储

- 新增 `DeviceIdentityStore` / `UserIdentityStore`，显式区分 create 与 load。
  缺失、已存在、损坏、外来、占用分别是 StorageError。load 绝不会生成替代身份。
  Node Layer 包装既有 SQLite 存储和格式，不是第二套身份协议。
- Electron 的 `E2eeDeviceService` initialize/create/load 与 `E2eeUserService`
  create/load 在 IPC Promise 边界组合这些 Layer。恢复文件导出/核对仍走 Promise
  用户存储。
- 证据：core 类型检查；Effect 身份测试（缺失、创建、已存在、同一 id 加载）；
  Electron node+web 类型检查。仍未提交于 `e2448e49`。
  剩余：ContentCipher Effect、3 处协议桥、Lab host/content-session 原生组合、
  用户恢复 Effect、四类性能、根目录 `pnpm check` 与阶段提交。

### 2026-09-22 — 原生 verify/extend；协议桥已拆除

- `LedgerView` 改为包装 `InternalState`，不再包装会 throw 的 `Ledger`。
  `pure/ledger-apply.ts` 对已解码记录做 Either 重放。workflow 用
  `SignatureVerifier.verifyMany` 批量验外层签名和 admitMember 证明（一个 Effect
  内紧循环），再应用权限。admitDevice 证明仍在重放中验证，因为目标 membership
  来自前序状态。
- 引擎在构造时捕获 `SignatureVerifier`；之后的 execute/refresh/resume 不再声明。
  Promise `LedgerClient` 通过 `fromInternal` 为 `./ledger` 调用方重建 `Ledger`。
- 已删除 `workflows/protocol.ts`。`check:effect-boundaries --complete` 报告 0 桥。
  证据，未提交于 `e2448e49`：core 类型检查；40 项 Effect 客户端/类型/验证测试；
  73 项密钥/快照/存储/投递测试；Lab 类型检查。ContentCipher、Lab content-session/host、
  恢复文件、四类性能和根目录 `pnpm check` 仍开放。未 commit/push。

### 2026-09-22 — 内容/恢复 Effect 与四类性能

- `pure/content-frame.ts` 以 Either 拥有头编码/解析和 XChaCha 封装/打开。
  `workflows/content.ts` 使用 `ContentAuthority` / `ContentCrypto`。
  Promise `ContentCipher` 将 `ContentError` 解包为 `ControlLogError`；策略回调
  抛错仍是 defect（`unauthorized-author` 仍会冒出）。`inspectContent` 仍是同一
  解析器的抛错解包。线路码、HKDF 上下文、nonce/messageId 注入和 await 前复制
  未改。
- `pure/recovery-file.ts` 拥有文件解析、备份头和 AEAD 帧。
  `UserIdentityStore.sealBackup` / `recover` 包装既有 SQLite 存储。
  Electron 恢复导出/导入/核对在 IPC Promise 边界组合这些方法。
  Lab 的 `createStreamsContentProvider` 和 host `Ledger.verify` 仍是列出的
  SDK 解包，不是第二套算法。
- 证据：core `pnpm check` 38 文件 / 486 测试（含 10k journal）；
  `check:effect-boundaries --complete` 0 桥；Lab `pnpm check` 18 文件 / 142
  测试；Electron 类型检查。四类 1000 条中位（3 预热 / 10 次，Node v24.21.0）：
  重放 1140 ms，增量 extend(+1) 1.76 ms，快照加入 156 ms，journal 恢复+验证
  1148 ms。重放低于此前约 1215–1268 ms 基线。产品 E2EE 仍关闭。随后根目录
  `pnpm check` 与阶段提交。
- 根目录类型检查通过（含 Electron）。类型感知 lint：0 错误 / 11741 既有警告
  （修了 epoch-stream、node-epoch-files、ledger-keys、host-lifecycle 中 8 个
  no-shadow/consistent-return）。`pnpm test:ci` 仅 CLI `worktree-gc.test.ts`
  因 `/var` 与 `/private/var` 失败；该测试不在本迁移范围内，未改。
  其后的 i18n、code-collab、platform-boundary、public-boundary 检查均通过。

### 2026-09-22 — 根检查：规范化 worktree-gc 路径

- WorktreeManager 的 `hostPath` 本就使用 `realpathIfExists`。GC 扫描
  `path.join(reposDir, …)`，把未解析的 macOS `/var/folders` 拼写传给清理脚本。
  现在清理收到的路径与 `hostPath` 相同。资格判定、备份提交和保留分支规则未改。
  测试仍断言 `worktree.hostPath`，没有删除或放宽。
- 根目录 `pnpm check` 现已通过：类型检查、类型感知 lint（0 错误 / 11741 警告）、
  `test:ci`（含 CLI `worktree-gc.test.ts` 11/11 与 Electron）、i18n、code-collab、
  platform-boundary、public-boundary。产品 E2EE 仍关闭。随后本地提交此路径修复；
  不 push。

### 2026-09-22 — Lab submit 只表达意图

- 诚实 Lab `DemoSession.submit` 不再调用 `prepare` / `encodeSignedRecord`。
  它把操作映射为 `LedgerCommand` 并运行 `executeEffect`，由后者拥有 parent
  选择、签名和 CAS。攻击/矩阵探针仍在审计边界拼装原始记录。`createSpace`
  仍组合本地创世编码、密钥持久化和远端 POST；那是应用层 Org 开通，不是
  第二条提交路径。
- `LedgerEngine.legacy` 不再接收未使用的 point-cache 参数，workflow 不再
  导入 `../ledger/` 类型。core `pnpm check` 现在跑
  `check:effect-boundaries --complete`。
- 证据：core/Lab 类型检查；`--complete` 0 桥；Lab host-lifecycle 34、
  design-probes 25、collab-baseline 1；core execute/submit/node-store 65。
  产品 E2EE 仍关闭。不 push。

### 2026-09-22 — Lab createSpace 走意图 create

- 诚实 `DemoSession.createSpace` 先持久化 epoch-0 密钥，再由
  `LedgerClient.create` 把创世签入本地 journal。宿主 POST 仍由应用拥有，
  发生在本地耐久之后。普通路径不再调用 `encodeGenesisBody` /
  `encodeSignedRecord`。
- 证据：Lab 类型检查；host-lifecycle 34、design-probes 25、collab-baseline 1。
  产品 E2EE 仍关闭。不 push。

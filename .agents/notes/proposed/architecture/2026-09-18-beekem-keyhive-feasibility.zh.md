# BeeKEM / Keyhive 与 Lody 权限账本对照

Status: proposed
Translation: current

[English](./2026-09-18-beekem-keyhive-feasibility.md)

## 摘要

IACR ePrint [2026/1434](https://eprint.iacr.org/2026/1434) 是 BeeKEM：去中心化连续群密钥协商协议，不是权限或身份体系。外围的 Keyhive（汇合能力、群组 CRDT、BeeKEM、Beelay）是面向 Automerge 的并发、可不依赖中心服务器的访问控制。Lody 已确认的首版形状相反：单一 Owner、线性签名账本加 CAS 全序、可信 Streams 新鲜度、显式角色与设备类型、按设备线性 HPKE 代次信封。整套搬入会推翻这些决定，且仍补不齐恢复设备、机器、Guest 与执行时限。crate 为 pre-alpha、未经审计；Loro Streams 是比 BeeKEM 假设更强的排序者，其并发机制会闲置。对未来 Team 范围密钥真正有用的只有嵌套群，仍需要一层 Lody 策略。不要把白皮书改成以 BeeKEM 为权限模型。

## 论文实际规定的内容

BeeKEM（[Yen, Fábrega, Da, Kleppmann, Mumm, Park, Zelenka](https://eprint.iacr.org/2026/1434)）是 DCGKA：成员在认证因果广播下协商一串群密钥，不假设投递服务把操作排成全序。

- 数据结构：TreeKEM 风格的 NIKE/DH 二叉树，外加 Create/Add/Remove/Update 的 hash DAG。
- 顺序 Update 常见代价 \(O(\log n)\)，并发更新或空白/冲突解析时退化为 \(O(n)\)。
- 安全：参数化的 \(\kappa\)-FSU、PCS，以及新的 **跨分叉安全**。并发 Add/Remove 物化规则为 **撤权优先**。Add/Remove 之后根密钥未定义，直到下一次 Update。
- 实现：Rust，见 [inkandswitch/keyhive](https://github.com/inkandswitch/keyhive/tree/main/beekem)；Keyhive/Beelay 仍是 pre-alpha，未经审计。

Keyhive 的「权限栈」有三层，BeeKEM 只是第三层：

```text
汇合能力  →  群组 CRDT（设备/团队/文档）
         →  BeeKEM 群密钥 + 因果块密钥
Beelay：RIBLT 成员同步 + sedimentree 密文
```

Keyhive 明确排除真人身份绑定、固定小角色集、交互协议和中心权威。文档和人都是 Ed25519 主体组成的群。写权限来自能力图；读权限来自持有当前群密钥。

## Lody 的规格与实现

约束意图：兄弟树白皮书
`../lody-e2ee-design/specs/e2ee/whitepaper.md` 与[账本规范](../../../../specs/e2ee-ledger.zh.md)。实现：`packages/e2ee-core` 的 `Ledger.verify` / `applyOperation`、HPKE `sealEpochEnvelope`、随 `publishEpoch` 入账的历史包。

```text
线性签名账本（CAS）     →  谁可以行动（角色 ∩ 设备类型 ∩ canManage）
独立 HPKE 信封         →  当前代密钥发给每个有效设备及 R
换代记录中的历史包     →  K_n 包装 K_{n-1}
JWT / 15 分钟时限      →  云端拉取与机器执行截止
```

已确认并已编码：唯一可转让 Owner；Admin 可接纳 Member 并换代，但不能移除成员或任命 Admin；Guest 只读；机器无 `canManage`；恢复设备 R 收钥且仅可授权本人个人设备；撤设备仅当前 Org 且仅指名目标；快照加入依赖外带创世 + Owner/Admin 背书者 + 担保 head。白皮书已引用 DCGKA 作研究背景，并 **拒绝** 其并发群组协议，改用可信后端顺序。该选择记在[控制账本笔记](2026-09-12-e2ee-control-log.zh.md)；本稿不重开。

## 为什么整套搬入不可行

| 轴 | BeeKEM / Keyhive | Lody 首版 | 冲突 |
| -- | ---------------- | --------- | ---- |
| 「授权」是什么 | 能力图 + 并发群组 CRDT | 顺序 RBAC 账本 | 产品不同 |
| 排序 | 因果合并；并发操作保留冲突钥 | CAS 全序；先提交者生效 | 邀请后移除的答案不同 |
| 撤权与并发加入 | 合并后撤权优先 | 谁先 CAS 成功谁赢 | 安全模型 S4 |
| Owner | 无唯一 Owner；两名 admin 可互撤 | 恰好一名 Owner | 产品不变量 |
| 角色 / 设备 | 无约束主体 | owner/admin/member/guest；personal/machine/recovery | Keyhive 反目标 |
| 身份 | 范围外 | 用户身份、成员实例、邮箱 UX | BeeKEM 之上仍要做 |
| 后端 | 可选不可信中继 | 诚实 Streams：完整前缀、不分叉不回滚、JWT | Lody A3/A5 |
| 成员变更后 | 根空白直到 Update | 继续用当前代写入，直到 Owner/Admin 换代 | 可用性 vs PCS |
| 密钥代价 | 顺序 Update \(O(\log n)\) | \(O(\#devices)\) HPKE 信封 | ~20 人足够 |
| FS / 历史 | BeeKEM 有 \(\kappa\)-FSU；Keyhive 应用层仍共享历史 | 共享保留历史；无 FS | 同一 CRDT 约束 |
| 恢复 / 机器 / 15 分钟 | 未规定 | 首版要求 | 仍是 Lody 工作 |

搬入整栈不会消掉这些 Lody 表面。它会替换已经实现的账本、快照加入和代次 outbox，再在一个合并规则（撤权优先、admin 互撤）正是 Lody 已放弃的 CRDT 上，重做 Owner、Guest、R、机器和执行时限。

BeeKEM 的证明也不能平移。它假设认证因果广播和诚实执行协议，不证明 Lody 的快照背书、JWT 截止或机器命令授权。Keyhive 笔记写明：BeeKEM 的 FS 不是 Keyhive 的 FS，因为因果块密钥会重新暴露前驱——与 Lody 历史包是同一取舍。

## 值得学、但不必换栈的点

1. **授权与密钥继续分层。** 已是现设计。BeeKEM 是密钥协议；成员策略在别处。不要让 TreeKEM 叶子变成角色表。
2. **CRDT Org 不该追求应用层前向保密。** 两边都得到：解开当前块必须能解开保留历史。Lody 的历史包是 Keyhive 因果密钥的顺序对应物。
3. **PCS 是换代策略，不是新账本。** 今天的 Lody PCS 等待 Owner/Admin `publishEpoch`。BeeKEM 的每叶 Update 是失陷后自动愈合。便宜版本是「撤权后尽快换代 / 定时换代」，仍用 HPKE。只有信封扇出——而不是策略——成为瓶颈时，TreeKEM 才划算。
4. **A3 成立时，跨分叉安全无关。** CFS 存在是因为 DCGKA 允许分区各自定义群密钥。Lody 禁止控制面分叉。若后端撒谎，Lody 已承认可隐瞒撤权和分裂 Owner 历史；不放弃 CAS 的话，BeeKEM 修不了这一点。
5. **拉取 / 读取 / 写入。** Keyhive 的 pull 能力对应 Lody 的 JWT / 快照准入：取密文弱于解密，解密弱于写。继续分开检查；不要把 `open` 成功当成当前写权限。
6. **若有将来，只做适配器。** 未来的 `KeyDelivery` 可以说 BeeKEM（或普通 TreeKEM），从 `Ledger.state` 取 **当前已验证设备集** 再产出代次密钥。谁在集合里仍由账本决定。不要让离线客户端向 BeeKEM 并发 Add/Remove。叶子应是设备，R 与 Guest 不得 Update/写。在首批验证规模下仍无必要。

## 考虑过的替代

- **整套采用 Keyhive。** 拒绝：并发能力授权、无 Owner、无身份、pre-alpha、Automerge/Beelay 形同步，与 CAS 账本冲突。
- **现在就把 BeeKEM 当 Org 密钥层。** 拒绝作为 v1：线性 HPKE 可接受；根空白直到 Update 与可用性优先的换代打架；Wasm/Rust 绑定和并发 Update 图是新攻击面，且没有规模需求。
- **在 Lody 已有全序上采用 MLS/TreeKEM。** 比 BeeKEM 更接近，因为 Lody 已有排序者。仍不采用：白皮书禁止 MLS；换代稀少且由 Owner/Admin 门控；FS 不是目标。
- **保留当前账本 + HPKE + 历史包。** 保留。符合已确认意图和已交付的 `e2ee-core` 表面。

## 后续：成熟度、Team 与 Streams（2026-09-18）

后续问题是：BeeKEM 是否成熟到可以接入；若重写白皮书、把它当 **权限模型**，能否覆盖长期 Team 以及人、设备、机器。结论：**不要把白皮书改成以 BeeKEM 为授权模型。** 对未来 Team 隔离真正有用的是 Keyhive 式嵌套群。crate 不是可上产品的权限系统；Loro Streams 已经提供比 BeeKEM 所需更强、也不同的排序性质。

### 成熟度

| 信号 | 证据 |
| ---- | ---- |
| 论文 | ePrint 2026/1434，DCGKA 博弈下有证明；预印本，不是 IETF/MLS 级标准 |
| Crate | `beekem` 0.3.0（2026-06-26），`keyhive_core` 0.5.0；约两个树内依赖 |
| 作者口径 | 论文称 Rust 实现 “production-ready”；Keyhive notebook 04 写 **不要用于生产**、API 不稳、**无审计** |
| 应用 | Ink & Switch Patchwork；Automerge/Beelay 形态，不是 Loro |
| 谁可 Add/Remove | BeeKEM 本身不限制调用者；文档假定由 Keyhive 提供因果投递 |

「作为账本后面的 Org 密钥适配器」仍是研究级接入。「替换权限模型」不行。

### BeeKEM 仍然不是权限模型

把白皮书改成「用 BeeKEM 做权限模型」，实际买的是三样东西：

```text
Keyhive 群组 + 能力     →  谁存在（Org/Team/人/设备）
BeeKEM                  →  一个群的共享读密钥
Lody 策略（仍然要）     →  Guest、canManage、R、机器执行、15 分钟
```

BeeKEM 成员资格是二元的：叶子能解群密钥或不能。没有 Owner、Admin、Guest、`canManage`、仅恢复、或「这台设备可以让那台机器执行命令」。这些仍是应用策略。Keyhive 故意把真人身份和固定小角色集排除在范围外。

### Team / 人 / 设备 / 机器

嵌套群 **可以** 描述长期形状：

```text
Org
  Team Eng ──► 文档 {D1, D2}   每份文档 ≈ 一棵 BeeKEM 树
    Alice（人群）
      电脑 / 手机 / R
    Alice 的机器（个体）
  Team Design ──► 文档 {D3}
```

这是真正值得学的一点：**按资源分密钥**，Team Eng 的密文不能用 Design 的代次解开。今天的单一 Org 代次不拆钥就长不成这样。

它完不成权限管理：

- **Guest / 读 vs 写 vs 管理** 需要额外的群或能力。同一棵 BeeKEM 树上的 Guest 叶子能解开这棵树加密的全部内容。
- **机器** 作为叶子，与人拿到同一把群密钥。执行授权（目标、命令、请求 ID、15 分钟时限）在 BeeKEM 之外。机器与前端用户配对是 Lody 协议。
- **恢复设备 R** 需要密钥，且必须用策略禁止写和 Update。失陷的 R 在 Remove + 后续 Update 之前仍在树里（Remove 后根空白）。
- **嵌套成员变更** 才是难点：Alice 加人一台设备，必须传到所有包含 Alice 人群的文档 BeeKEM 树。这是 Keyhive 的工作，不是 `beekem` crate 的，也没有针对 Loro 的规格。
- 若以后「Team」只是账单下的另一个加密 Org，当前账本再 mint 一个 genesis 即可。只有「一个 Org 里要隔离子团队、又要共享部分文档」才需要嵌套 BeeKEM。

### 协议安全与性能

论文证明：ACB 与诚实执行下的 \(\kappa\)-FSU、PCS、\(\kappa\)-CFS。不证明：快照背书、JWT 截止、机器命令、「只有 Owner 能移除」、身份绑定。

CRDT 历史下应用层 FS 仍然放弃（Keyhive 因果密钥，Lody 历史包）。Add/Remove 后根未定义直到 Update——PCS 更严，可用性差于「继续用当前代写入」。

性能（论文，顺序，8–512 人）：Update/Remove 原语 \(O(\log n)\)；新成员 Process \(O(h_B)\) 历史回放；welcome 每轮 Update 约增 2.5 kB / 40 µs。分区愈合代价随期间做过 Update 的成员比例升到 \(O(n)\)。约 20 人时 HPKE 更简单。成百人 × 多设备时，对数换代优于每叶一份 HPKE——前提是换代频繁。Lody 换代由 Owner/Admin 门控，次数少。

有排序者时，更接近的 CGKA 是普通 TreeKEM/MLS。BeeKEM 多出来的是并发冲突钥，CAS 下几乎用不到。

### Loro Streams 是否满足 BeeKEM 的外部性质

BeeKEM 假设认证因果广播：因果投递、最终可靠、发送者认证。实现用带签名的 hash DAG 操作在可靠广播上构造 ACB。

| ACB 性质 | 今天使用的 Loro Streams |
| -------- | ---------------------- |
| 认证 | HTTP/JWT 外加 Lody 记录签名；除非每条 CGKA 操作都签，否则不是 BeeKEM 操作认证 |
| 因果序 | **更强**：单流 CAS 全序。若所有操作都追加到该流，全序是合法 ACB |
| 可靠投递 | 不保证到达所有成员。JWT 可扣留；托管 `/append-cas` 仍是 **501** |
| 分叉 / 分区 | A3 **禁止**。CFS/CUC 与冲突钥闲置 |
| Add 所需 PKI | Lody 加入申请可提供初始 DH 公钥 |

只有把 BeeKEM 操作序列化进控制流，后端才符合 ACB，同时 **浪费** BeeKEM 存在的理由（无服务器并发）。Streams **不能** 在断网时网格/分区继续改控制面；离线客户端仍不能分叉控制头。JWT 扣留是撤权想要的，与 ACB 可靠性是不同性质。

Beelay（RIBLT + sedimentree）不能替换 Streams/Loro。采用 BeeKEM 密钥后，内容仍走 Durable Streams。

### 实现复杂度

即使只做密钥层也高：Rust/`keyhive_wasm` 或 TS 重写；设备映射为叶子；根空白 vs 当前代继续写；保留 JWT 准入；保留 R 与机器。若作为权限模型重写：替换 `Ledger`/`verifySnapshot`/outbox，实现能力或嵌套群策略，在 Loro 上发明 Team 成员传播，接受撤权优先而非 CAS 先到先得，若仍要唯一 Owner 还得另证。那是新协议，不是适配器。

## 限度

本稿来自 ePrint PDF、Keyhive lab notes、crates.io/docs.rs 上的 `beekem` 0.3.0、兄弟树白皮书/权限账本，以及当前 `packages/e2ee-core` 策略、Streams 适配器和交接（托管 CAS 501）。没有重证 BeeKEM，没有在 Lody 负载上对比 HPKE 与 BeeKEM，也没有改 Spec。无 PR。以后若重访 Team 范围密钥或发钥规模，仍须人类决定。

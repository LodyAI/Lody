# 独立权限账本：类型、API 与对账设计

Status: draft
Translation: pending

本稿是协议与验证意图：记录如何编码、什么操作在什么状态下合法、宿主不能替核心做什么。
不是实现排期、测试计划或 freeze 清单。协作者是否接受一条记录，只取决于自己已验证的
前置状态能否通过与核心相同的检查（`Ledger.verify` / `extend`）。

## 术语

没有密码学背景也可以从这里读起。后文用到这些词时，含义以本节为准；公式和操作表在后面章节。
「工作区」与 Org 同义。创世哈希、`genesis`、Org 身份、信任锚（`anchor`）在已确认设计里是同一条创世记录的哈希。

### 人、设备与组织

| 说法               | 英文                           | 含义                                                                                                                                                           |
| ------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 加密组织           | Org                            | 一套独立的成员、权限、账本和文档加密密钥。口语也叫工作区。首版不再套一层 Team（旧产品里 Team 是 Org 之上的分组，本稿没有）。                                   |
| 用户               | user                           | 成员和角色的主体，是人，不是某台电脑。                                                                                                                         |
| 成员实例           | membership                     | 某用户在本 Org 的这一次资格。移除后再加入是新实例，旧资格不复活。                                                                                              |
| 设备               | device                         | 一台电脑、手机、远程机器或恢复设备。每台自己生成密钥，不复制旧设备私钥。                                                                                       |
| 个人 / 机器 / 恢复 | personal / machine / recovery  | 设备种类。机器不能管理 Org；恢复设备平时不运行，只用来收密钥和批准本人的新个人设备。                                                                           |
| 角色               | Owner / Admin / Member / Guest | 用户在本 Org 的权限档。Guest 只读。设备不另存一套角色。                                                                                                        |
| 管理能力           | `canManage`                    | 这台个人设备能不能做邀请、发布新一代密钥等管理操作。必须和用户角色取交集：Admin 的普通手机若未授予管理能力，仍不能发布新一代密钥。机器和恢复设备必须为 false。 |
| 恢复设备           | recovery device，文中常写 R    | 已登记、平时不上线的虚拟设备。私钥用 Passkey 或恢复文件包起来，需要时才解锁。                                                                                  |
| Passkey            | Passkey / PRF                  | 系统级通行密钥；这里只用它派生一段密钥来包装 R 的私钥。Passkey 不是 R，也不能代替账本授权。真机 PRF 仍待验收。                                                 |
| 用户根私钥         | user root key                  | 旧设想：每人一把凌驾于所有设备之上的私钥。本稿没有这种钥匙；恢复走登记过的 R。                                                                                 |

### 账本长什么样

| 说法        | 英文                 | 含义                                                                                                                   |
| ----------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 权限账本    | authorization ledger | 一条公开可验证的权限历史：谁是成员、哪台设备有效、现在第几代。服务端能保存和读取，但不能靠改自己的用户表来授解密权。   |
| 授权事实    | authorization facts  | 账本上可公开验证的状态：成员、角色、设备、公钥、当前代次和密钥指纹等。不是密钥材料。                                   |
| 创世记录    | genesis              | 账本的第一条记录。它的哈希就是本 Org 的身份。必须从二维码等账本之外的可信渠道确认，不能因为记录「自称」可信就信。      |
| 哈希 / 摘要 | hash / digest        | 把任意字节压成固定 32 字节指纹。相同输入得到相同结果，几乎无法从指纹反推原文，改一个字节指纹就变。                     |
| 哈希链      | hash chain           | 每条新记录都写上一条的哈希（`previousHash`）。改中间任何一条，后面全部对不上。账本是一条线，不自动合并分叉。           |
| 前驱        | predecessor          | `previousHash` 指向的那条上一记录。                                                                                    |
| 链头        | head                 | 本机已验证的最后一条记录的哈希。提交下一条时要对着这个值。                                                             |
| 增量        | suffix / increment   | 创世或权限快照之后新追加的记录。快照**之前**的历史叫前缀（prefix），新人首次加入不必下载前缀。                         |
| 签名        | signature            | 用设备私钥在特定字节上盖章；别人用对应公钥能验证「就是这台设备签的」，但签过不等于这台设备有权做这件事。               |
| 单签        | single-signer        | 一条账本记录只有一个提交者签名。操作内部仍可附带别人的持钥证明。                                                       |
| 多签        | multi-signature      | 旧原型里一条记录要多人签。本稿不用。                                                                                   |
| 持钥证明    | possession proof     | 新设备用自己的私钥签一段绑定 Org 和新公钥的数据，证明它真的拿着对应私钥，而不是别人替它登记一把公钥。                  |
| 在线格式    | wire                 | 真正发送和落盘的原始字节，不是调试用的 JSON/hex 文本。                                                                 |
| DAG-CBOR    | DAG-CBOR             | 记录的二进制编码：固定顺序的数组，哈希和密钥都是原始字节。只借用这种编码，不引入 IPFS、CID 或可合并的协作图。          |
| 线性账本    | linear ledger        | 成功提交的顺序就是权限顺序。不用 MLS（一种群组密钥协议），也不用授权 DAG（一种可分叉合并的授权图）或「谁先撤权谁赢」。 |

### 密钥、承诺与信封

| 说法                | 英文                                       | 含义                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 公私钥              | public / private key                       | 公钥可公开；私钥不出设备。签名和加密各用一对，不能混用。                                                                                                                                                                   |
| 对称密钥            | symmetric key                              | 加密和解密用同一把。内容密钥 `K` 就是对称密钥。                                                                                                                                                                            |
| 内容密钥 / 代次密钥 | epoch key，文中常写 `K`（第 n 代写 `K_n`） | 随机抽出的 32 字节对称密钥。文档密钥由它按 Org、代次、文档再派生，不能写进账本明文。                                                                                                                                       |
| 代次 / 换代         | epoch / rotation                           | 内容密钥的世代，从 0 起每次加一。换代 = 作废当前 `K`、发布新的 `K`。旧密钥解不了新内容；已经拿到的旧密钥和旧明文收不回。操作名 `publishEpoch`。                                                                            |
| 承诺                | commitment                                 | 钥匙的公开指纹，不是钥匙本身。别人看见承诺推不出 `K`；你以后也只能出示原来那把 `K`。公式见 §2。代码里同一字段还叫 `keyCommitment`、`epochCommitment`、`epoch0Commitment`。                                                 |
| 域分隔摘要          | domain-separated digest                    | 哈希前先拼一个用途标签（如 `"lody-e2ee/epoch-key/v1\0"`），避免「当记录哈希用的 SHA-256」被拿去冒充「当密钥承诺用的 SHA-256」。                                                                                            |
| 信封                | envelope                                   | 把当前代 `K` 用接收设备的加密公钥封好的一份密文。只发给那台设备，不写在账本明文里。解开后必须再算承诺，和账本对上才算拿到正确的钥匙。旧文「每设备密钥包」指这个，不是历史包。                                              |
| 独立投递通道        | key-delivery channel                       | 发信封用的传输，和账本记录不是同一条流。账本负责授权事实；投递通道负责把 `K` 送到设备。                                                                                                                                    |
| 历史包 / 历史密钥包 | history packet                             | 换代记录里的一小段密文：用新 `K` 加密上一把 `K`。图里的 `H_n` 就是第 n 代这条密文。新成员拿到当前 `K` 后可以沿历史包解开全部旧钥。验证账本的人把它当不透明字节，不解密。字段名 `previousEpochKey` / `previousEpochKey72`。 |
| nonce / 认证标签    | nonce / tag                                | 加密时附带的随机数和校验尾，解密必须原样使用。历史包 72 字节 = 24 字节 nonce + 32 字节密文 + 16 字节标签。                                                                                                                 |
| HPKE                | HPKE                                       | 封信封用的标准公钥加密（RFC 9180）。记住「给指定设备封一份只有它能解的密文」即可。                                                                                                                                         |
| 发布 vs 送到        | published vs delivered                     | 账本上出现承诺 = 这一代已发布。每台设备真正解开信封 = 已送到。前者不蕴含后者。                                                                                                                                             |

§8.1 的「记录外层」是账本记录怎么编码，和这里封给设备的信封不是同一件事。

### 提交、对账与信任

| 说法              | 英文                               | 含义                                                                                                                                                          |
| ----------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 宿主              | host                               | 账本外层：落盘、CAS、发信封、查时钟。纯验证核心不算宿主。                                                                                                     |
| 条件追加          | CAS，Compare-And-Swap / append-cas | 服务器只在「当前链头还是我看到的那个哈希」时收下我这条记录。否则冲突。冲突后必须重新准备，不能改已签名的字节再发。                                            |
| 待提交 / 未知结果 | pending / unknown outcome          | 本地必须先原样存好将要发送的字节，再去 CAS。没收到回执时，用同一份字节去对账，禁止换一把新签名重发（那会变成另一条记录）。                                    |
| 对账              | reconcile / compare                | 两台设备核对自己验证过的历史：同一创世、同一长度、同一链头（快照路径还要核完整权限状态）。远端口头说「hash 一样」不算数。                                     |
| 权限快照          | authorization snapshot             | 已有设备对「当前完整权限状态」的签名摘要。新人可先验证快照再追后续增量，不必从创世验完全部历史。                                                              |
| 内容快照          | content snapshot                   | 某篇文档在某一读位置上的加密快照，走文档流，不是权限账本快照。协作文档本身用 CRDT（可合并的副本数据类型）同步；权限账本不是 CRDT。                            |
| 背书者            | endorser                           | 签署权限快照的那台设备。必须是当时有效的 Owner/Admin 个人管理设备。快照不能仅凭内部自称 Owner 来证明签署者资格。                                              |
| 信任锚            | trust anchor / `anchor`            | 验证开始前，从账本之外带入的创世哈希。程序不能自己发明「创世可信」。                                                                                          |
| 公钥目录          | key directory                      | 服务端上的公钥通讯录。签名只能证明「持有这把私钥」，不能独自证明「这是某个人」。                                                                              |
| 配对              | pairing                            | 用二维码等账本之外的信道核对公钥和创世哈希。                                                                                                                  |
| 纯验证核心        | pure verifier                      | `Ledger.verify` / `extend`：只解析、哈希、验签、重放权限，不联网、不读盘、不读系统时间。写库、发信封、做 CAS 的是宿主。                                       |
| 防重放            | replay protection                  | 用过的申请 ID、设备公钥等不能再用来做另一次授权。重新签名并换前驱，不是同一次原文重试。                                                                       |
| 新鲜度            | freshness                          | 当前状态合法，不等于「现在仍然该执行」。已知撤权应立即失效；上传是否被后端接受，仍可能依赖宿主的时钟和最多 15 分钟的网关/JWT 截止。本稿不宣称已验证生产网关。 |
| 跨流              | cross-stream                       | 权限账本和文档内容不在同一条服务器流上，没有「两条流一起成功或一起失败」的事务。                                                                              |
| 续读位置          | continuation offset                | 文档流上已接纳内容的位置。内容快照卡在这个位置，不能靠自报时间或账本 head 冒充。                                                                              |
| `verified=true`   | —                                  | 禁止出现的捷径：调用方声称「已经验过」从而跳过验签。磁盘对象必须再走 `Ledger.verify` 或 §6.1 的快照入口。                                                     |

不要求先读 MLS、Merkle 树（一种树状哈希证明）或 IPFS。本稿明确不用它们。

### 外层名字与文中编号

| 说法                     | 含义                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------- |
| Convex                   | 产品云端表，只适合存加入申请的待处理/取消。表状态不是密码学授权。                  |
| Streams / `streams-crdt` | 本地或托管的字节流和文档同步。账本 CAS 走它的 `append-cas`；文档加密复用它的接口。 |
| JWT / 网关               | 生产上云端访问控制的设想。实验室用薄 HTTP 网关代替；本包不宣称已接线。             |
| D1 A                     | Owner 单方转让：当前 Owner 的管理个人设备单独签名，接任者须已是成员。              |
| D2                       | 创世代承诺暂不编 genesis；持钥模块解开后按 §2 公式核对。                           |
| D3                       | 账本没有 cancel 操作；用过的申请 ID 永久消费。                                     |
| D4–D5                    | §8 的操作字段和权限交集（角色 ∩ `canManage` ∩ 设备种类）。                         |

## 1. 目标与确认范围

首次加入采用经过认证的已有设备签署的权限快照，不要求从创世重放全部账本；此后
逐条验证增量。完整历史保留供按需审计。服务端负责保存和 CAS 排序，不能靠替换
用户表或声称“签名有效”授予权限。账本保持线性，不用 MLS、
DAG 或自动合并分叉。本稿取代[旧原型](e2ee-control-log.zh.md)的通用多签记录方案，
不是对现有代码已迁移的声明。

已确认方向：纯验证核心、不可变验证视图、DAG-CBOR 固定数组、普通记录单签、完整记录
hash、独立的每设备密钥分发通道、随换代记录保存的历史密钥包；普通记录不重复 OrgID（旧字段，现用 genesis hash 标识 Org）、序号或通用操作 ID。下列 TypeScript
表达逻辑类型，不冻结 API 拼写和字节编码。恢复采用已登记的恢复设备，不再单设用户根私钥；
具体操作证据、创世格式与版本策略仍待审。

## 2. 明文与秘密的边界

权限账本可以明文保存并让服务端读取，但不意味着向所有人公开。成员关系、设备公钥、
权限与变更历史是可见元数据，不宣称这些没有隐私价值。邮箱、设备名称和 IP 不默认
进入永久账本。私钥、内容密钥、业务内容不得进入明文记录。

当前代内容密钥（epoch key）是随机抽出的 32 字节，用来加密这一代的文档；它不能写进账本明文。
每台合格设备各自收到一份用自己加密公钥封好的信封（envelope），走独立投递通道。
换代记录里另有一份固定大小的历史包（history packet）：用新密钥加密上一把密钥。
这是密文，外人看不到明文。

账本只保存授权事实，以及一个密钥承诺（commitment）。承诺不是钥匙，而是钥匙的公开指纹：

```text
epoch ≥ 1:  commitment = SHA-256("lody-e2ee/epoch-key/v1\0" || genesis || epoch || K)
epoch = 0:  commitment = SHA-256("lody-e2ee/epoch-key/v1\0" || K)
```

`K` 是 32 字节内容密钥；`genesis` 是本 Org 创世记录 hash；`epoch` 是 4 字节大端无符号代次编号。
带标签的哈希（domain-separated digest）把 Org 身份和代次编进输入，同一把 `K` 不能拿去冒充另一个工作区或另一代。
创世代（epoch 0）要等创世记录自己算出 hash 才有 genesis，因此这一代的承诺不编 genesis。
承诺可以公开，但不能加密文档，也反推不出原密钥。

设备解开信封后，必须再算一遍承诺，和账本上这一代的值对上，才接受这把密钥。
账本出现承诺只表示这一代已发布（published），不表示每台设备都已送到（delivered）。
承诺只出现在创世和换代操作 `publishEpoch`（见 §4、§8.2）里，不是每条记录都有的字段。

## 3. 最小记录类型

```ts
type RecordBody = {
  previousHash: Hash;
  signer: SigningPublicKey;
  operation: Operation;
};

type SignedRecord = {
  body: RecordBody;
  signature: Signature;
};

// wire 为固定顺序的 DAG-CBOR 数组；hash、公钥和签名均为 byte string
// body   = [previousHash, signer, operation]
// record = [body, signature]
// signingBytes = domainForSignature || encode(body)
// recordHash   = Hash(domainForRecord || encode(record))
```

- `signer` 可直接使用设备签名公钥，不另造设备 ID；必须从前一验证状态核对其资格。
  公钥自带的有效签名不能自授权。签名同时覆盖前驱、公钥和完整操作。
- `previousHash` 连接完整前一记录，逐条绑定到可信 genesis。因此普通记录不重复 OrgID；
  位置由链推导，保存在索引中，不签入序号。
- 精确记录 hash 用于识别同一提交。通用记录不设操作 ID；业务所需的一次性标识
  留在具体操作里，例如加入申请 ID。重新签署并换前驱不是同一次原文重试。
- 单签指一条记录只有一个提交者签名，不代表操作内部只能有一个签名证明。
- 创世记录是专门类型，不能用空前驱的普通记录伪装；需要可信渠道确认其 hash。
  Org 随机标识只在 genesis 中出现，或直接使用 genesis hash 作为 Org 身份，尚待定。
- 版本由 genesis 声明而非逐条重复是建议，尚待确认；不能默认采用旧原型版本号。
  编码必须唯一，未知格式、非规范字节、超限记录拒绝，不宽松解析后重写来验签。

### 序列化选择（2026-09-13 已确认）

使用 `@ipld/dag-cbor`，取代 JSON + hex；保留固定数组 schema。hash、公钥、签名
在 JS 中使用 `Uint8Array`，在线格式中直接编码为 CBOR byte string，不经过 hex、
Base64 或 JSON 字符串。调试展示时才转可读文本，不改变签名与 hash 使用的字节。
只采用 codec，不引入 CID、IPFS、Merkle 树或 DAG 协作模型，账本仍是线性 hash chain。

```ts
const bodyBytes = encode([previousHash, signerPublicKey, operation]);
const signingBytes = concat(signatureDomain, bodyBytes);
const signature = sign(signingBytes); // 设备私钥在核心外盖章；signingBytes 只在这里用
const recordBytes = encode([[previousHash, signerPublicKey, operation], signature]);
const recordHash = hash(concat(recordDomain, recordBytes));
```

最终要保存和 CAS 的是 `recordBytes`（整条记录的原始字节）。`recordHash` 是它的身份：下一条的 `previousHash`、CAS 期望的链头，都对着它。
`signingBytes` 不会编进记录里。它只是「拿去签名的那一串字节」：标签 + 已经编码好的 body。验签时用同一公式重算，再拿公钥检查 `signature`。

编码器不能代替 schema 和规范字节验证。固定数组避免 map 键排序歧义；数字限定
有界整数，并拒绝用浮点 CBOR token 表达整数等非规范形式，不能只在解码后检查
`Number.isInteger()`。尾随数据、类型不符、未知字段、超限和过深嵌套都须拒绝。
具体检查路径与版本固定在实现阶段验证，不能把 `decode()` 成功视为规范性证明。
官方说明 JS 实现没有强制 map 键顺序和浮点编码宽度，需纳入负面测试。
参考：[DAG-CBOR 规范与解码严格性](https://ipld.io/specs/codecs/dag-cbor/spec/#decode-strictness)、
[JS codec](https://github.com/ipld/js-dag-cbor)。

减少字符串转换是选择理由，不是已测性能结果；零拷贝、分配量仍须
实测。不得因更换 codec 隐式改变验签规则或接受旧 JSON 格式作为降级路径。

## 4. 权限状态与业务操作

以下是 Org 策略层的概念状态，不要求通用链验证器认识所有产品字段：

```ts
type OrgState = {
  owner: MembershipId;
  members: ReadonlyMap<MembershipId, Member>;
  devices: ReadonlyMap<SigningPublicKey, Device>;
  epoch: EpochState;
};
type Member = {
  userId: UserId;
  role: 'owner' | 'admin' | 'member' | 'guest';
  // 用户是成员主体；恢复公钥放在设备条目，不另设用户根私钥
};
type Device = {
  membershipId: MembershipId;
  kind: 'personal' | 'machine' | 'recovery';
  encryptionPublicKey: EncryptionPublicKey;
  canManage: boolean;
};
type EpochState = {
  number: number;
  keyCommitment: Hash;
  rotationRequired: boolean;
};
```

`keyCommitment` 即 §2 的 commitment。`rotationRequired` 在移除成员或撤销设备后为 true，表示应当尽快换代；`publishEpoch` 成功后回到 false。纯验证器不因为这个标志就拒绝其它操作。

签名公钥用于验证作者，加密公钥用于接收信封，两者用途不同；以上均为公开信息。
不再用含糊的 `identityKeys` 或 `encryptionKey` 字段名。恢复设备使用相同的独立
签名/加密公钥与成员绑定，不在 Member 上另设恢复公钥或要求所有设备保管用户私钥。
`machine` 与 `recovery` 的 `canManage` 必须为 false；恢复授权是单独允许的本人
设备操作，不是管理 Org。Guest 为只读成员，其有效签名仍能用于持钥和本人设备流程，
不能用于内容写入或机器执行。其余角色的内容/执行权仍受具体目标范围与设备限制。

用户与成员实例分开：用户被移除后重入产生新 `MembershipId`，旧资格不复活。
设备公钥重登记的拒绝规则或实例绑定须在设备操作中明确；不能因以公钥作 ID 而允许
旧设备请求重放。公开视图可仅列有效条目，内部仍需保存防重放所需事实。
`ReadonlyMap` 是类型示意；实现不得把内部可修改的 Map 直接暴露给调用方。

| 操作       | 记录提交者 / 操作内证据                                              | 效果                                                                                     |
| ---------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 创建 Org   | 创始设备签名                                                         | 一个创世操作登记用户、唯一 Owner、首设备和首代承诺（epoch-0 commitment）；信任锚另行核验 |
| 接纳成员   | Owner/Admin 管理设备；附绑定用户与首设备的持钥申请证据               | 新成员以 Member 加入，不提前发当前密钥；Guest 加入/角色调整的精确入口待审                |
| 移除成员   | Owner 管理设备                                                       | 撤该成员实例全部资格，不连带其他成员                                                     |
| 调整角色   | Owner 管理设备                                                       | Admin/Member/Guest 变更，不借此转让 Owner                                                |
| 接纳设备   | 本人有效个人设备；恢复设备仅可授权本人的新个人设备；附新设备持钥证明 | 直接绑定当前成员实例，记录明确设备能力；恢复能力授予字段待审                             |
| 撤销设备   | 本人有效个人设备                                                     | 仅撤本 Org 的目标设备，不沿批准关系传播                                                  |
| 转让 Owner | 当前 Owner 管理个人设备单签（D1 A）                                  | 唯一 Owner 转移，前任变 Admin；接任者须已是成员且非当前 Owner                            |
| 发布 Epoch | Owner/Admin 管理设备                                                 | 记录新代、commitment 及 history packet；每设备 envelope 独立投递，发布不等于所有端已送到 |

不提供 `patchState` 等任意状态修改。权限来自用户角色与设备能力的交集，机器不能
管理。申请者不是通用 signer 类型；其公钥只能验证加入意愿和持钥，不能自授权。
申请、待处理和取消状态由外部系统（可用 Convex 表）管理，不新增未知公钥可写的
账本入口。最终接纳仍绑定被批准的用户、公钥和必要持钥证据，不能把表内状态当作
密码学授权；已接纳不能通过取消表项回滚。取消与批准的后端协调契约仍须明确。

操作内同意证明须绑定目标 genesis、参与身份/成员实例、具体操作参数和防重放信息；
外层提交者签名覆盖完整证明。加入申请不绑定不断变化的 head，最终批准记录才绑定
head。Owner 单方转让已确认（D1 A）：当前 Owner 管理个人设备单签；接任者须已是
有效成员且不是当前 Owner；前任变 Admin。无接任者签名。

### 恢复设备（2026-09-13 已确认）

恢复设备 R 是已登记且平时不运行的设备，不是待批准申请，也不是用户根身份。
由本人有效个人设备批准，在各个获准 Org 的设备表登记其独立签名/加密公钥并绑定
当前成员实例。每次换代给全部有效设备发钥时也包括 R，密文由既有设备分发通道保存；
不再维护一套用户恢复公钥收件人列表。新加入 Org 必须另行登记 R，不能仅凭账号
关联自动把它加入。首次登记和跨 Org 配置的具体操作组合仍待 API review。

R 的用途限定为接收 Org 密钥、授权本人的新个人设备；不能直接写内容、执行命令、
邀请他人、换代、改角色或移交 Owner。恢复不是 Guest 角色；即使用户是 Owner，
R 也没有直接管理权限。已确认：用户当前为 Owner/Admin 时，R 可显式授予新个人
设备管理能力；Member/Guest 不允许授予该能力。提交时同时检查 R、成员当前资格和
明确的能力字段；解密成功本身不授予管理权。字段编码仍须随操作 API 确认。
恢复后由有效个人设备明确撤销丢失设备，不由 R
执行任意治理或偷偷连带撤销。

R 的私钥以加密备份保存，Passkey PRF 或恢复文件是包装入口，不是 R 的公私钥本身。
普通端不常驻 R 的秘密；创建或恢复期间临时解锁，结束后清理，不复制旧实体设备钥。
备份绑定预期 R、用户及必要的 Org 信任锚；其精确格式单独审定，服务端位置/账号
表不能自行决定可信创世或替换 R。包装材料变化不要求逐次改写历史内容密钥。

恢复流程：解锁 R → 验证账本及 R/成员当前资格 → 打开已投递给 R 的当前代信封
并核对其 commitment → 从账本 history packet 恢复旧钥 → 生成新设备 C 的独立密钥，R 签署本人设备
授权且 C 提供持钥证明 → CAS 入账后使用 C，清理 R 的临时秘密。恢复和解密都是
有前提的：R 未登记、已撤销、成员失效或信封缺失时不能宣称成功；不要求其他
设备此刻在线，仅限所需密文已经持久保存的情况。密钥投递失败显示“同步失败：
端到端加密密钥分发失败”，保留已入账事实并重试投递，不重复登记。

撤销 R 复用本 Org 的明确目标设备撤销，停止新钥投递并触发换代；不复活旧成员，
也不连带撤销此前由 R 批准的 C。若实体端曾复制恢复秘密，仅撤该实体端不足，
还须撤对应 R 并核对其它设备；清理内存不证明秘密未被窃取。多个入口包装同一 R
时，删一个入口不能作废已复制的私钥。已确认首版同一用户的备份入口共用一个 R，
Passkey 与恢复文件分别包装相同 R 的私钥；不引入每入口独立 R。任一入口泄漏并
暴露 R 秘密后，须替换整个 R、更新所有已启用入口并对相关 Org 明确撤旧 R/换代。
设备撤销仍逐 Org 生效，不宣称跨 Org 原子撤销；此配置不绕过各 Org 的登记。

验收须覆盖：全实体设备丢失而有效 R 可恢复最新及历史内容；未给 R 投递的新代
不能被旧备份恢复；只撤 A 不撤 R/C；撤 R 后拒绝其新授权和发钥但 C 保留；移除
成员使全部类型设备失效；Guest 恢复不升级、R 不能直接发机器命令；换代投递失败
和恢复过程中撤权。以上为设计用例，尚未执行；旧用户身份恢复原型不算本设计实现。

参考 [Messenger Labyrinth 的虚拟设备设计](https://engineering.fb.com/wp-content/uploads/2026/05/Minos-Updates-2026-Encrypted-Backups-White-Paper.pdf)
中的恢复设备与秘密清理取舍；不采用其完整协议或继承其证明。

### 历史密钥随换代入账（2026-09-13 已确认）

每一代生成独立随机的 Org 对称密钥 `K_n`，不是轮换设备公私钥。除创世代外，
换代操作必须携带一个历史包：用 `K_n` 认证加密上一代密钥 `K_(n-1)`。
加密上下文绑定可信 genesis、前后代次和独立的历史密钥用途；具体编码随密码学
模块定稿。操作字段的逻辑名称为 `previousEpochKey: Uint8Array`，实际仍编码为
DAG-CBOR 固定数组中的 byte string，包含解密所需的 nonce、密文与认证标签。

```text
K₂ → 解开换代记录中的 H₂ → K₁ → 解开 H₁ → K₀
```

`H_n` 是第 n 代 `publishEpoch` 记录里的那份 history packet（72 字节），不是另一把密钥。

新成员获授全部历史：收到当前代密钥后，从已验证账本取得历史包并逐级恢复旧钥。
旧密钥不能反向推导新密钥；已撤权者已取得的历史明文和旧钥不能收回。
只包上一代，每轮增加一份固定规模密文，不随设备数或历史代数复制全部旧钥。

历史包受换代记录的签名和 hash chain 覆盖，不再另设历史流、历史包发布器或
跨流提交协议。验证核心只检查字段格式、大小、签名与发布者权限，将密文视为
不透明字节；无须持有内容密钥、解密或联网，纯账本及对账边界不变。
记录签名不证明包内密钥正确：持钥模块解密后仍须核对该旧代的 commitment，
失败必须明确报错，不能跳过缺失/损坏的代次。历史包是否正确不影响对账本签名
事实的验证；恶意管理员造成历史解锁失败的修复不属于首版坏链修复能力。

换代流程：先安全保存新密钥及包含历史包的精确待提交记录，再 CAS 提交；未知结果
按账本原文对账，不重新生成候选。确认入账后，按已验证的当前权限向各有效设备
独立分发当前代密钥，失败可重试。账本提交只保证历史包随记录一并保存，不保证
每设备信封已经送达、持久安装或所有写者同时切代；继续沿用已确认的上传可用性与
总撤权窗口，不引入跨文档流的瞬时切代保证。

新成员加入也是先确认接纳入账，再交付当前代密钥；解锁历史不恢复已失效的权限。
每设备分发可由外层适配 Convex 或 Streams，独立核心不依赖其私有类型。
后端只需耐久保存和传输账本字节，不解释密钥；历史换代记录必须随 Org 历史保留，
不能按普通消息 TTL 或裁剪策略删除。服务端仍能拒绝提供或删除历史，签名不提供
可用性保证；原始历史缺失时不能宣称已完成全量验证或历史恢复。

文档增量、批处理、重试及加密接入复用 `@loro-dev/streams-crdt`，不另造平行内容
API。应用持钥模块负责历史钥查找，并通过现有 provider 接入；当前锁定版本的
provider 不代管 Org 密钥存储或权限。旧原型的独立历史流实现不是本设计要求，
本次只确认设计，迁移与删除旧实现留到独立包实现阶段。

## 5. 纯核心 API

```ts
const ledger = await Ledger.verify({ anchor, records });
const next = await ledger.extend(suffix);
ledger.head;
ledger.state;
ledger.summary(); // genesis、长度、head：本机已验证摘要
ledger.hashAt(position); // 本机已验证位置的 hash
```

`records` 是含 genesis 的内存原始字节；`anchor` 是可信输入。入口完成解析、hash、
全部签名和权限重放，不接受 `skipSignatureVerification` 或宿主伪造的“已验证”对象。
`extend` 失败不修改原视图，不返回失败批次中可用于授权的部分新状态；内部可共享
结构，不要求每次复制全部日志。错误应指出失败位置与类别，不能吞错后继续授权。

纯指没有网络、文件、系统时间、随机数等隐式副作用；入口可以异步。历史重放不能
用今天的时间推翻当时合法的授权；依赖提交时到期检查的操作需独立、明确的证据设计。
当前状态有效不等于足够新鲜，执行授权必须由外层结合可信新鲜度边界判断。

构造接口候选如下；尚未冻结，不要求立即照此实现：

```ts
const proposal = ledger.prepare(operation, signerPublicKey);
const signature = await signer.sign(proposal.signingBytes); // 外部密钥句柄
const record = await ledger.finalize(proposal, signature);
```

`finalize` 验证完整记录及操作内证据；不联网，也不代表 CAS 已提交。适配器先持久保存
精确记录，再 CAS。丢响应查询原 hash/原文并核对历史；未知结果不换签名重发。
冲突后刷新、验权、重新准备，旧签名不能直接换前驱；业务一次性事实防止重复授权。

## 6. 对账与外层职责

### 6.1 签名快照引导

核心入口已落地：`prepareSnapshot` / `finalizeSnapshot` / `verifySnapshot` / `openFromSnapshot` /
`comparisonNote` / `compareNotes`。这不是产品上线：独立核对 UI、真机 Passkey、生产网关截止仍待宿主验收。

首次加入不要求全历史验签/权限重放。采用已有设备对当前权限状态的签名背书，允许加入后通过额外信道与其他成员核对。
这不是继承 MLS 协议或证明，也不是把旧 `Ledger.verify` 改成跳过签名。

- **信任起点。** 接收端固定预期 Org 与背书设备身份。配对或额外信道确认可认证
  公钥；未独立核验的首次联系仍依赖目录。签名匹配不能证明真人身份，快照不能
  仅凭内部自称 Owner/Admin 来证明签署者资格。2026-09-14 确认：信任输入为外带
  `genesis`、`endorser`、担保的最新 `head`，以及 endorser 对该 head 的签名
  （`lody-e2ee/head-attest/v1\0` || genesis || head），表示担保该版本及此前版本。
  加入背书者须为声称状态中当前有效的 Owner/Admin 个人管理设备。
- **背书内容。** 签名及跨端核对摘要必须绑定协议/用途、Org 创世身份、账本位置与
  head，以及接收端实际采用的完整权限状态。状态须足以独立处理后缀，包括成员
  实例/角色、设备公钥/能力/撤销、Owner、Epoch 承诺，以及已消费请求、旧成员实例
  等防重放事实。正确 head 搭配被替换、未受该签名覆盖的状态必须失败；不是普通
  内容 CRDT 快照。若恶意背书者亲自签署结构合法的虚假状态，单凭验签无法识破，
  需通过独立核对发现视图差异，或完整审计检查历史与状态是否相符。
- **加入与后续验证。** 校验编码、签名、身份/范围绑定和状态结构后建立可信起点；
  标记为背书引导，而非从创世独立审计。后续每条记录仍检查前驱、所有签名/证明、
  前一状态权限及防重放。CAS、未知结果、撤权、新鲜度规则不变；不能用新快照自动
  跨过已知坏链、替换已固定 Org 或覆盖不一致的本地状态。
- **独立核对。** 用户可先加入，不强制等待第二人。没有额外核对时显示“尚未独立
  核对”；可信额外信道上与其他成员在相同位置核对相同状态摘要后，记录“已在该
  位置独立核对”。仅邀请者再次背书不等于独立核对。不同位置先追平或核对共同
  位置，不能直接判分叉；同位置不一致须显式报错，不能标已核对或自动选长链。
- **安全取舍。** 首次引导信任背书设备的状态判断。背书者与服务端合谋能在独立
  核对前欺骗新人；与至少一名诚实、未被攻破且身份确实认证的成员核对可检测不同
  视图，但不是每个真人身份、全历史合法性或全球最新的证明。核对只覆盖指定位置，
  后续变更不能自动继承“最新状态已独立核对”。不强制部署见证服务或多签门槛。
- **历史、恢复与持久化。** 原始控制历史和历史密钥包继续保留，可按需审计/取钥；
  不要求下载它们才能首次加入。按需取得的历史包/旧代承诺须能认证关联到接受的
  状态，不能只信服务端自报。磁盘恢复也须验证背书材料并验证后缀，不能接受裸状态
  或 `verified=true`。R 恢复不因本变更强制要求管理员实时在线；所需引导材料的持久
  保存、验证及缺失错误须单独验收，解开 R 私钥或内容钥不能自行授予快照可信性。

2026-09-14 确认入口：`prepareSnapshot` / `finalizeSnapshot` / `verifySnapshot` /
`comparisonNote` / `compareNotes`。`verifySnapshot({ trust, snapshot, suffix })`
的 `trust` 含 genesis、endorser、head、headSignature。快照为链外 DAG-CBOR，不是
普通 op。当前 `Ledger.verify/extend` 测试只证明全量/增量路径；快照路径以
`test/ledger-snapshot.test.ts`、`test/ledger-snapshot-client.test.ts` 和公开
`bench/readme-consumer.ts` 为准。
不得把反序列化对象当成账本视图。普通记录 wire 不变。

快照路径必须拒绝：坏签名、错 Org/背书者、`head` 正确但状态不受该签名覆盖、缺少防重放所需字段、越权后缀、回滚。通过快照+后缀得到的状态，须与从创世完整重放同一后缀后的状态一致。有效背书者可以签署结构合法的虚假状态；验签通过不证明历史合法，须靠独立核对或全量审计发现。

### 6.2 已建立起点后的增量对账

1. 交换 genesis、长度与 head。不同 genesis 是不同账本，不能拼接。
2. 两份独立验证历史的长度/head 相同则历史相同；快照引导的视图还须核对 §6.1 的
   完整状态绑定。远端自报摘要只能指导拉取，不授予权限。
3. 长度不同则取得共同位置的可验证链信息。相同前缀成立才取后缀并 `extend`。
   远端一句“那个位置的 hash 相同”不能证明它后来声称的 head 确实延伸自此。
4. 相同长度但不同 head，或发现共同位置不一致，需要验证记录来确定分叉并保留证据；
   不把未经验证的远端声明当作已经证实的分叉，不自动选长链。
5. 远端落后、历史缺口、截断、坏签名或越权都不能被包装成“最新”；已验证历史保留。

`compare/reconcile/needsEvidence` 暂不冻结为公开 API。先用最小拉取示例验证是否只需
`summary/hashAt/extend`；必须区分“已验证关系”和“尚需拉取的记录”，避免重复验证。
本地位置/hash 索引可重建，不入签名；不要求引入 Merkle 证明。

网络适配器负责分页、CAS 与远端声明；存储适配器负责原子保存记录、验证位置和
pending。磁盘数据的恢复验证/可信边界须明确，不能仅反序列化就授予验证资格。
服务端隐藏更新或分发不同有效历史，不由 hash chain 独自解决；最新性和跨端核对
是独立保证。上述适配器可以独立测试，不依赖 Lody UI 或 Convex 私有类型。

## 7. 性能

「一万条从零全签重放 ≤100ms」已撤销，不是测量达标。日常路径按签名快照引导和增量追赶，
不以历史长度要求每次从零验证；按需全量审计仍验证全部签名和权限。不指定新的毫秒阈值。

## 8. 操作编码与检查

整数均为无符号、最短 CBOR；公钥/签名/hash 为原始字节；账本不含 CBOR 文本。
Org 身份与信任锚是 **genesis 记录 hash**。创世代承诺无法把尚未算出的 genesis hash
放进摘要；持钥模块解开后按 §2 核对（D2）。

前置条件指该记录入账**之前**的 `OrgState`。协作者接受一条操作，当且仅当自己已验证的
前置状态通过与 `decodeRecord` + 验签 + `applyGenesis` / `applyOperation` 相同的检查。
代码：`packages/e2ee-core/src/ledger/{ledger,policy,schema}.ts`。有限模型对照见
`test/ledger-model.ts`，不是协议证明。

### 8.1 记录外层

记录外层是账本记录的编码，不是封给设备的密钥信封。

```text
genesisBody   = [protocolVersion=1, signer, userId, membershipId, encPub, epoch0Commitment]
ordinaryBody  = [previousHash, signer, operation]
signingBytes  = "lody-e2ee/sig/v1\0" || encode(body)
signature     = Sign(signingBytes)          // 私钥在核心外；不把 signingBytes 编进记录
record        = [body, signature64]
recordHash    = SHA-256("lody-e2ee/rec/v1\0" || encode(record))
epoch ≥ 1:    commitment = SHA-256("lody-e2ee/epoch-key/v1\0" || genesis || epoch || K)
epoch = 0:    commitment = SHA-256("lody-e2ee/epoch-key/v1\0" || K)
```

`K` 为 32 字节；`epoch` 为 4 字节大端 uint32。

创世与普通记录靠 `body[0]` 的 CBOR 类型区分（uint 版本 vs 32 字节 hash），不能用空前驱冒充创世。
未知 `protocolVersion`、非规范整数、浮点、尾随字节、超限、过深嵌套、map/文本/CBOR tag（这里的 tag 是编码类型，不是 §8.2 的操作码）一律拒绝。

| 限制                       | 值                                     |
| -------------------------- | -------------------------------------- |
| 记录最大                   | 8192 字节                              |
| 嵌套深度                   | 8                                      |
| 数组长度                   | 32                                     |
| 单段 bstr                  | 256 字节                               |
| Ed25519 公钥 / 签名 / hash | 32 / 64 / 32                           |
| 加密公钥                   | 32 字节、非全零                        |
| membershipId / requestId   | 16 字节                                |
| userId                     | 32 字节不透明账号绑定                  |
| 历史包                     | 72 字节（24 nonce + 32 密文 + 16 tag） |

签名公钥必须是规范、非零、素阶子群点（实现细节：验证库 `zip215: false`，签名里的点 A 与 R 都做子群检查）。不使用 JSON/hex 降级。

### 8.2 操作编码

| tag  | 操作          | 数组                                                              |
| ---- | ------------- | ----------------------------------------------------------------- |
| 创世 | createOrg     | `genesisBody`，见 §8.1                                            |
| 1    | admitMember   | `[1, membershipId, joinRequest]`                                  |
| 2    | removeMember  | `[2, membershipId]`                                               |
| 3    | setRole       | `[3, membershipId, role]` role=1 admin / 2 member / 3 guest       |
| 4    | admitDevice   | `[4, kind, newSign, newEnc, canManage, possessionSig]` kind=0/1/2 |
| 5    | revokeDevice  | `[5, targetSign]`                                                 |
| 6    | transferOwner | `[6, successorMembershipId]`                                      |
| 7    | publishEpoch  | `[7, epoch, commitment, previousEpochKey72]` epoch≥1              |

### 8.2.1 每条记录都要过的检查

对应 `Ledger.verify` / `extend`（`ledger.ts`），在操作策略之前：

1. 字节规范：DAG-CBOR 固定数组、无 map/文本/浮点/未知 tag、无尾随字节、不超过 §8.1 限制。`encode(decode(bytes))` 必须等于原文。
2. 提交者签名：`signer` 对 `signingBytes` 的 Ed25519 有效。签名有效 ≠ 有权。
3. 创世只能在位置 0；其 `recordHash` 必须等于外带 `anchor`。不能用空前驱的普通记录冒充创世。
4. 位置 ≥ 1：`previousHash` 必须等于当前已验证链头，否则 `wrong-parent`。
5. 未知操作 tag 拒绝。操作内嵌套证明（加入申请、持钥证明）在策略前验签，失败为 `bad-proof`。
6. 不读系统时钟。`expiresAt`、申请表取消位只在宿主提交前检查，重放不得用「现在」否定当时已入账的记录。

### 8.2.2 各操作的前置状态（`policy.ts`）

下列「提交者」均须是**当前有效**设备（在 `devices` 里）。已撤销的公钥不能再当 signer。

**创世 `createOrg`**（`applyGenesis`）

- 之前没有任何记录。
- `protocolVersion = 1`；签名公钥为规范素阶点；加密公钥 32 字节非全零。
- 效果：该 `userId` / `membershipId` 成为唯一 Owner；创始设备为 personal 且 `canManage=true`；epoch=0，承诺为 `epoch0Commitment`。信任锚仍须外带确认。

**`admitMember`**

- 提交者：有效 personal **且** `canManage` **且** 角色为 Owner 或 Admin（`requirePersonalManage`）。Guest 不能邀请。
- `membershipId` 从未在本 Org 用过；该 `userId` 当前没有有效成员资格。
- `(firstSign, requestId)` 未消费；`firstSign` / `firstEnc` 从未在本 Org 出现过（含已撤设备）。
- `joinRequest` 由 `firstSign` 签名，覆盖 genesis 与申请字段。核心不查 `expiresAt`。
- 效果：恒为 Member（不能经此授予 Guest/Admin）；第一台设备为 personal、`canManage=false`。不发当前代密钥（宿主随后发信封）。

**`removeMember`**

- 提交者：Owner 的管理个人设备（`requireOwnerManage`）。Admin 不能移除成员。
- 目标是当前有效成员，且不是当前 Owner。
- 效果：该 `membershipId` 下全部设备失效；`rotationRequired=true`。不连带其他成员。

**`setRole`**

- 提交者：Owner 的管理个人设备。Admin 不能改角色。
- 目标是当前有效成员，且不是当前 Owner；新角色 ∈ {admin, member, guest}，不能设为 Owner（转让走 `transferOwner`）；新角色不能与当前相同。
- 效果：只改角色。不置 `rotationRequired`。

**`admitDevice`**

- 提交者：本人当前有效的 personal，**或** 本人的 R（`requireOwnPersonalOrRecovery`）。不要求提交者 `canManage`。
- R 只能接纳 `kind=personal`。Guest 不能接纳 machine。
- `machine` / `recovery` 的 `canManage` 必须 false。`canManage=true` 仅当新设备是 personal **且** 该成员当前为 Owner/Admin。
- `newSign` / `newEnc` 从未在本 Org 出现。持钥证明由 **新设备** `newSign` 签署，绑定 genesis、新公钥、kind、`canManage`。
- 效果：设备挂到提交者的当前 `membershipId`。不沿批准关系形成授权树。

**`revokeDevice`**

- 提交者：本人当前有效 **personal**（R 不能撤设备）。
- 目标是本 Org 当前有效设备，且与提交者同一 `membershipId`。
- 效果：只删该设备；`rotationRequired=true`。不撤销该设备曾经批准过的其它设备。

**`transferOwner`**（D1 A）

- 提交者：当前 Owner 的管理个人设备，单签。接任者不必签名。
- 接任者已是有效成员，且不是当前 Owner。
- 效果：前任变为 Admin，接任者变为 Owner。

**`publishEpoch`**

- 提交者：Owner 或 Admin 的管理个人设备。Guest/Member 不能换代；机器不能换代。
- `epoch === 当前代次 + 1` 且 ≥ 1。`commitment` 从未在本 Org 出现。
- `previousEpochKey` 为 72 字节；验证器当不透明字节，不解密、不核对其是否真是上一把 `K`（持钥模块解开后再对旧代 commitment）。
- 效果：当前代次与承诺更新；`rotationRequired=false`。不表示每台设备已送到信封。

`joinRequest = [requestId, userId, firstSign, firstEnc, expiresAt|null, signature]`。
`firstSign` / `firstEnc` 是申请者第一台个人设备的签名公钥和加密公钥；`expiresAt` 是宿主提交前预检用的截止时间（毫秒），纯验证重放不读时钟。
申请由该首台设备签名，覆盖 `"lody-e2ee/join/v1\0" || encode([genesis, requestId, userId, firstSign, firstEnc, expiresAt])`。
无用户根私钥。重放不用“现在”否定历史。
`(firstSign, requestId)` 永久消费。账本无 cancel 操作（D3）。

持钥证明覆盖 `"lody-e2ee/possess/v1\0" || encode([genesis, newSign, newEnc, kind, canManage])`，由新设备签名。
`revokeDevice` 的 `targetSign` 是被撤设备的签名公钥。

设备 ID 即签名公钥。签名/加密公钥一旦在本 Org 出现即作废，重入新成员也不得复用。
用户移除后可带新 membershipId 回来。公开 `devices` 只含有效条目。

### 8.3 权限交集（摘要）

管理类操作（接纳/移除成员、改角色、换代、转让）要求：有效 personal **且** `canManage` **且** 当前角色允许。
本人设备接纳/撤销不要求提交者 `canManage`。R 只能接纳本人 personal。
`canManage=true` 仅当目标是 personal **且** 当前角色为 Owner/Admin（含 R 恢复管理设备）。
Guest 可接纳/撤销本人 personal 与登记 R，不可登记 machine、不可换代/邀请/改角色。
Admin 可接纳 Member 并换代，不可改角色、移除成员或转让。机器无管理权。

### 8.4 域分隔常量

```text
lody-e2ee/sig/v1\0
lody-e2ee/rec/v1\0
lody-e2ee/join/v1\0
lody-e2ee/possess/v1\0
lody-e2ee/epoch-key/v1\0
lody-e2ee/epoch-history/v1\0
lody-e2ee/r-wrap/v1\0
```

`r-wrap` 是包装 R 私钥（Passkey 或恢复文件）时用的域标签。当前恢复文件实现仍使用
`lody-recovery-file/v1` / `lody-recovery-backup/v1`，尚未切到这一常量。

## 9. 公开 API 与调用示例（草案）

入口：`@lody/e2ee-core` 导出 `Ledger` / `LedgerError`；完整编解码与域常量在 `@lody/e2ee-core/ledger`。
纯核心：无网络、无磁盘、无隐式时钟。随机数只出现在宿主生成密钥/ID 时。

```ts
import { Ledger } from '@lody/e2ee-core';
import {
  encodeGenesisBody,
  encodeSignedRecord,
  hashRecord,
  joinRequestSigningBytes,
  possessionSigningBytes,
  signingBytesForBody,
  commitEpochKey,
} from '@lody/e2ee-core/ledger';

const body = encodeGenesisBody({
  signer,
  userId,
  membershipId,
  encryptionPublicKey,
  epochCommitment,
});
const genesis = encodeSignedRecord(body, await sign(signingBytesForBody(body)));
const anchor = await hashRecord(genesis); // 外带确认后才信任
const ledger = await Ledger.verify({ anchor, records: [genesis] });

const proposal = ledger.prepare(
  { type: 'admitMember', membershipId: newId, request: joinRequest },
  ownerSignPub
);
const record = await ledger.finalize(proposal, await sign(proposal.signingBytes));
const next = await ledger.extend([record]); // 失败则 ledger 不变
next.head;
next.state;
next.summary();
next.hashAt(0);
```

`finalize` 只验完整记录，不 CAS。宿主：精确保存原文 → CAS → 读回 hash/原文。
未知结果不重签。冲突则刷新、验权、重新 `prepare`。

发钥（宿主，非 verify 核心）：入账后按已验证收件人用 HPKE 封当前代密钥；
失败显示同步失败并重试同一密文。换代记录已含 72 字节历史包，不再另发历史流。

恢复（宿主）：`openRecoveryDevice` 解 R 私钥 → `Ledger.verify` → 打开已投递给 R 的当前代信封并核对 commitment →
沿历史包解旧钥 → R 签署 `admitDevice` personal（Owner/Admin 可显式 `canManage`）→ CAS 后清理 R 秘密。

错误码：`canonical|truncated|trailing|oversize|nesting|unknown-version|unknown-operation|bad-signature|bad-proof|invalid-key|unauthorized|replay|wrong-parent|wrong-anchor|genesis-mismatch|owner-transfer-unconfirmed|invalid-operation`，可带失败位置。

新验证器拒绝旧 JSON/hex 与 team v1/v2/v3 域，不把旧字节迁移成新记录，也不删除用户磁盘上的旧文件。

## 10. 宿主契约（恢复、发钥、申请、新鲜度）

- 申请表（Convex 等）只存待处理/取消；不能把表状态当作授权。CAS 先成功者生效。无跨系统事务。
- 生产准入必须在 **原子提交点** 再查 `expiresAt` 与取消位；核心重放不读时钟。
- 各 Org 独立登记 R；备份包装绑定预期 R 公钥、userId 与调用方提供的创世锚列表，服务端定位不能换锚。
- 新鲜度：已知撤权立即失效；原始截止不因转发/重启延长；15 分钟 JWT/网关/长连接是宿主前提，本包不宣称已验证。
- 调用方不得传 `verified=true` 跳过验签。磁盘对象走 `Ledger.verify`；快照恢复走 §6.1。
- 内容快照与权限账本快照分离：有文档写权限的设备（含机器）可签署内容快照，Guest/只读不可。
  不引入跨流事务。宿主已接纳的历史内容快照不因作者随后被撤而自动失效；发表证据是宿主在该
  continuation offset 接纳的快照字节。不自动裁剪账本历史或历史密钥包。

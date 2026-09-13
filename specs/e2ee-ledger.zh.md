# 独立权限账本：类型、API 与对账设计

Status: draft
Translation: pending

## 1. 目标与确认范围

首次加入采用经过认证的已有设备签署的权限快照，不要求从创世重放全部账本；此后
逐条验证增量。完整历史保留供按需审计。服务端负责保存和 CAS 排序，不能靠替换
用户表或声称“签名有效”授予权限。账本保持线性，不用 MLS、
DAG 或自动合并分叉。本稿取代[旧原型](e2ee-control-log.zh.md)的通用多签记录方案，
不是对现有代码已迁移的声明。

已确认方向：纯验证核心、不可变验证视图、DAG-CBOR 固定数组、普通记录单签、完整记录
hash、独立的每设备密钥分发通道、随换代记录保存的历史密钥包；普通记录不重复 OrgID、序号或通用操作 ID。下列 TypeScript
表达逻辑类型，不冻结 API 拼写和字节编码。恢复采用已登记的恢复设备，不再单设用户根私钥；
具体操作证据、创世格式与版本策略仍待审。

## 2. 明文与秘密的边界

权限账本可以明文保存并让服务端读取，但不意味着向所有人公开。成员关系、设备公钥、
权限与变更历史是可见元数据，不宣称这些没有隐私价值。邮箱、设备名称和 IP 不默认
进入永久账本。私钥、内容密钥、业务内容不得进入明文记录。

每设备的当前代密钥包由独立通道传输；每次换代唯一的历史密钥包则直接放在换代
记录中，属于密文，不暴露明文密钥。账本同时保留必要的授权事实与密钥承诺。承诺是随机内容密钥的
域分隔摘要，绑定账本和代次；收件人解密后可核对密钥是否匹配。它不证明已送达，
也不是加密密钥。承诺属于 Epoch 操作，不是通用记录字段。

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
const recordBytes = encode([[previousHash, signerPublicKey, operation], signature]);
const recordHash = hash(concat(recordDomain, recordBytes));
```

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

签名公钥用于验证作者，加密公钥用于接收密钥包，两者用途不同；以上均为公开信息。
不再用含糊的 `identityKeys` 或 `encryptionKey` 字段名。恢复设备使用相同的独立
签名/加密公钥与成员绑定，不在 Member 上另设恢复公钥或要求所有设备保管用户私钥。
`machine` 与 `recovery` 的 `canManage` 必须为 false；恢复授权是单独允许的本人
设备操作，不是管理 Org。Guest 为只读成员，其有效签名仍能用于持钥和本人设备流程，
不能用于内容写入或机器执行。其余角色的内容/执行权仍受具体目标范围与设备限制。

用户与成员实例分开：用户被移除后重入产生新 `MembershipId`，旧资格不复活。
设备公钥重登记的拒绝规则或实例绑定须在设备操作中明确；不能因以公钥作 ID 而允许
旧设备请求重放。公开视图可仅列有效条目，内部仍需保存防重放所需事实。
`ReadonlyMap` 是类型示意；实现不得把内部可修改的 Map 直接暴露给调用方。

| 操作       | 记录提交者 / 操作内证据                                              | 效果                                                                      |
| ---------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 创建 Org   | 创始设备签名                                                         | 一个创世操作登记用户、唯一 Owner、首设备和首代承诺；信任锚另行核验        |
| 接纳成员   | Owner/Admin 管理设备；附绑定用户与首设备的持钥申请证据               | 新成员以 Member 加入，不提前发当前密钥；Guest 加入/角色调整的精确入口待审 |
| 移除成员   | Owner 管理设备                                                       | 撤该成员实例全部资格，不连带其他成员                                      |
| 调整角色   | Owner 管理设备                                                       | Admin/Member/Guest 变更，不借此转让 Owner                                 |
| 接纳设备   | 本人有效个人设备；恢复设备仅可授权本人的新个人设备；附新设备持钥证明 | 直接绑定当前成员实例，记录明确设备能力；恢复能力授予字段待审              |
| 撤销设备   | 本人有效个人设备                                                     | 仅撤本 Org 的目标设备，不沿批准关系传播                                   |
| 转让 Owner | 当前 Owner 管理个人设备单签（D1 A）                                  | 唯一 Owner 转移，前任变 Admin；接任者须已是成员且非当前 Owner             |
| 发布 Epoch | Owner/Admin 管理设备                                                 | 记录新代、承诺及历史密钥包；每设备密钥包独立交付，发布不等于所有端激活    |

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

恢复流程：解锁 R → 验证账本及 R/成员当前资格 → 打开已投递给 R 的当前代密钥包
并核对承诺 → 从账本历史包恢复旧钥 → 生成新设备 C 的独立密钥，R 签署本人设备
授权且 C 提供持钥证明 → CAS 入账后使用 C，清理 R 的临时秘密。恢复和解密都是
有前提的：R 未登记、已撤销、成员失效或密钥包缺失时不能宣称成功；不要求其他
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
换代操作必须携带一个历史密钥包：用 `K_n` 认证加密上一代密钥 `K_(n-1)`。
加密上下文绑定可信 genesis、前后代次和独立的历史密钥用途；具体编码随密码学
模块定稿。操作字段的逻辑名称为 `previousEpochKey: Uint8Array`，实际仍编码为
DAG-CBOR 固定数组中的 byte string，包含解密所需的 nonce、密文与认证标签。

```text
K₂ → 解开换代记录中的 H₂ → K₁ → 解开 H₁ → K₀
```

新成员获授全部历史：收到当前代密钥后，从已验证账本取得历史包并逐级恢复旧钥。
旧密钥不能反向推导新密钥；已撤权者已取得的历史明文和旧钥不能收回。
只包上一代，每轮增加一份固定规模密文，不随设备数或历史代数复制全部旧钥。

历史包受换代记录的签名和 hash chain 覆盖，不再另设历史流、历史包发布器或
跨流提交协议。验证核心只检查字段格式、大小、签名与发布者权限，将密文视为
不透明字节；无须持有内容密钥、解密或联网，纯账本及对账边界不变。
记录签名不证明包内密钥正确：持钥模块解密后仍须核对对应旧代的密钥承诺，
失败必须明确报错，不能跳过缺失/损坏的代次。历史包是否正确不影响对账本签名
事实的验证；恶意管理员造成历史解锁失败的修复不属于首版坏链修复能力。

换代流程：先安全保存新密钥及包含历史包的精确待提交记录，再 CAS 提交；未知结果
按账本原文对账，不重新生成候选。确认入账后，按已验证的当前权限向各有效设备
独立分发当前代密钥，失败可重试。账本提交只保证历史包随记录一并保存，不保证
每设备包已经送达、持久安装或所有写者同时切代；继续沿用已确认的上传可用性与
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

### 6.1 签名快照引导（已确认方向，尚未实现）

2026-09-13 决策修订：首次加入不要求全历史验签/权限重放，取消 10k/100ms 接入门槛。
采用已有设备对当前权限状态的签名背书，允许加入后通过额外信道与其他成员核对。
这不是继承 MLS 协议或证明，也不是把旧 `Ledger.verify` 改成跳过签名。

- **信任起点。** 接收端固定预期 Org 与背书设备身份。配对或额外信道确认可认证
  公钥；未独立核验的首次联系仍依赖目录。签名匹配不能证明真人身份，快照不能
  仅凭内部自称 Owner/Admin 来证明签署者资格。确切背书资格及引导证据在实现前定稿。
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

快照精确 wire、认证输入和 API 尚未冻结。当前 `Ledger.verify/extend` 及其已通过测试
只证明旧全量/增量路径；在独立入口完成前不得把反序列化对象当成账本视图。冻结普通
记录 wire 不变；快照不是新普通 op，也不向每条日志重新加入序号字段。

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

## 7. 性能与退出条件

10,000 条从零全签重放 ≤100ms 的 B 门槛已由用户明确撤销，不是测量达标。
暂停为该目标安排 SIMD/Wasm/多线程加速任务；不删除审计入口、既有基准或安全反例。
日常路径测签名快照引导、增量追赶、跨端摘要核对和资源用量，不以历史长度要求
每次从零验证；本次不指定新的毫秒阈值。按需全量审计仍验证全部签名和权限。

P1 公开面见第 8–11 节。D1–D5 已书面确认（D1=A；D2–D5=同意实现表）。
旧冻结面不覆盖 §6.1 的快照入口；新增设计、独立测试和审查未通过前不能交接为已实现。
原型 241 项测试不证明本稿已实现。

## 8. P1 操作与字段（D1–D5 已书面确认）

除非注明待确认，字段来自已确认规则，不另加通用 patch。整数均为无符号、最短 CBOR；
公钥/签名/hash 为原始字节；账本不含 CBOR 文本。Org 身份与信任锚是 **genesis 记录 hash**。
创世代承诺无法把尚未算出的 genesis hash 放进摘要：承诺字节对纯验证器不透明；
持钥模块的绑定方式见 D2。

### 8.1 记录信封

```text
genesisBody   = [protocolVersion=1, signer, userId, membershipId, encPub, epoch0Commitment]
ordinaryBody  = [previousHash, signer, operation]
record        = [body, signature64]
signingBytes  = "lody-e2ee/sig/v1\0" || encode(body)
recordHash    = SHA-256("lody-e2ee/rec/v1\0" || encode(record))
```

创世与普通记录靠 `body[0]` 的 CBOR 类型区分（uint 版本 vs 32 字节 hash），不能用空前驱冒充创世。
未知 `protocolVersion`、非规范整数、浮点、尾随字节、超限、过深嵌套、map/文本/tag 一律拒绝。

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

签名公钥必须是规范、非零、素阶子群点；验证 `zip215: false`，A 与 R 均检查子群。不使用 JSON/hex 降级。

### 8.2 操作

| tag  | 操作          | 数组                                                              | 提交者                                | 效果 / 拒绝                                                                        |
| ---- | ------------- | ----------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------- |
| 创世 | createOrg     | 见上，隐式 personal+canManage+Owner+epoch0                        | 创始设备                              | 信任锚外带核验                                                                     |
| 1    | admitMember   | `[1, membershipId, joinRequest]`                                  | Owner/Admin 管理个人设备              | 恒为 Member；Guest/Admin 不经此授予                                                |
| 2    | removeMember  | `[2, membershipId]`                                               | Owner 管理个人设备                    | 该实例全部设备失效；不能移除当前 Owner                                             |
| 3    | setRole       | `[3, membershipId, role]` role=1 admin / 2 member / 3 guest       | Owner 管理个人设备                    | 不能改当前 Owner；不能设 Owner                                                     |
| 4    | admitDevice   | `[4, kind, newSign, newEnc, canManage, possessionSig]` kind=0/1/2 | 本人有效 personal，或 R 仅可 personal | machine/recovery 的 canManage 必须 false                                           |
| 5    | revokeDevice  | `[5, targetSign]`                                                 | 本人有效 personal                     | 仅本 Org 该目标；不沿批准关系传播                                                  |
| 6    | transferOwner | `[6, successorMembershipId]`                                      | 当前 Owner 管理个人设备单签           | 接任者须已是有效成员且不是当前 Owner；前任变 Admin，接任者变 Owner。无接任者签名。 |
| 7    | publishEpoch  | `[7, epoch, commitment, previousEpochKey72]` epoch≥1              | Owner/Admin 管理个人设备              | 代次连续；承诺在本 Org 不重复；包不解密                                            |

`joinRequest = [requestId, userId, firstSign, firstEnc, expiresAt|null, signature]`。
申请由首台个人设备签名，覆盖 `"lody-e2ee/join/v1\0" || encode([genesis, requestId, userId, firstSign, firstEnc, expiresAt])`。
无用户根私钥。`expiresAt` 只供宿主提交前预检；重放不用“现在”否定历史。
`(firstSign, requestId)` 永久消费。账本无 cancel 操作（D3）。

持钥证明覆盖 `"lody-e2ee/possess/v1\0" || encode([genesis, newSign, newEnc, kind, canManage])`，由新设备签名。

设备 ID 即签名公钥。签名/加密公钥一旦在本 Org 出现即作废，重入新成员也不得复用。
用户移除后可带新 membershipId 回来。公开 `devices` 只含有效条目。

### 8.3 权限交集（D1–D5 已确认）

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

恢复（宿主）：`openRecoveryDevice` 解 R 私钥 → `Ledger.verify` → 打开已投递给 R 的当前代包并核对承诺 →
沿历史包解旧钥 → R 签署 `admitDevice` personal（Owner/Admin 可显式 `canManage`）→ CAS 后清理 R 秘密。

错误码：`canonical|truncated|trailing|oversize|nesting|unknown-version|unknown-operation|bad-signature|bad-proof|invalid-key|unauthorized|replay|wrong-parent|wrong-anchor|genesis-mismatch|owner-transfer-unconfirmed|invalid-operation`，可带失败位置。

### 9.1 旧 export 分类

| 符号                                                                | 处理                                         |
| ------------------------------------------------------------------- | -------------------------------------------- |
| `replayChain` / JSON `encodeRecord` / `team*` / `member.add` 多签   | 替换为 `Ledger`；旧入口暂留，P4 删除或内部化 |
| `HistoryPublisher` / `StreamsHistoryRemote` / history outbox        | 删除方向：历史包已在换代记录内               |
| `createUserIdentity` / `SqliteUserIdentityStore`                    | 删除方向：无用户根私钥；改为包装 R           |
| `join-request` JSON 版                                              | 替换为第 8.2 节申请数组                      |
| `ControlLogClient` / node-store / streams / `ControlFreshnessLease` | 保留概念，P2 换新记录格式                    |
| `ContentCipher` / `streams-content` / HPKE `KeyEnvelopeCipher`      | 保留，内容仍走 streams-crdt                  |
| `KeyDelivery` / received-key / device-store                         | 保留概念，上下文改绑新账本                   |

旧 JSON/hex 与 v1/v2/v3 team 域：新验证器拒绝，不迁移、不删除用户磁盘文件。

## 10. 宿主契约（恢复、发钥、申请、新鲜度）

- 申请表（Convex 等）只存待处理/取消；不能把表状态当作授权。CAS 先成功者生效。无跨系统事务。
- 生产准入必须在 **原子提交点** 再查 `expiresAt` 与取消位；核心重放不读时钟。
- 各 Org 独立登记 R；备份包装绑定预期 R 公钥、userId 与调用方提供的创世锚列表，服务端定位不能换锚。
- 新鲜度：已知撤权立即失效；原始截止不因转发/重启延长；15 分钟 JWT/网关/长连接是宿主前提，本包不宣称已验证。
- 调用方不得传 `verified=true` 跳过验签。现有磁盘对象仍走 `Ledger.verify`；新增快照
  恢复入口须实现 §6.1 的认证与增量验证后方可使用，不以文档决定冒充已落地。

## 11. 验收口径（快照决策修订）

- 首次加入只给快照和后缀，不给前缀；结果应与测试基准完整重放所得状态一致。
- 必须拒绝坏签名、错 Org/身份、head 正确但实际状态不受签名覆盖、缺少必要状态字段、越权后缀和回滚；已认证防重放事实须在后缀中生效。
- 有效背书者签署的结构合法虚假状态不能靠验签识别；测试须承认可接受但尚未独立核对，并用独立诚实端检测差异，不宣称验证器证明了历史合法。
- 核对覆盖未独立核对、可信同位置一致、位置不同、同位置不一致，以及邀请者单独
  背书不冒充独立核对。不得把“已核对历史位置”显示成“全球最新”。
- 历史取钥、R 恢复、重启与真实 SDK CAS/分页需分别从快照路径验收；内容快照来源
  证明不是权限快照，不随本次决定豁免。
- 性能报告分别标注引导/增量/全量审计、总字节、签名数、设备数及环境；保留统计
  样本，手机功能验证不以桌面模拟代替。没有新的 100ms 或等价隐含门槛。

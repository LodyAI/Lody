# 独立可信上下文下的紧凑内容包

Status: implemented
Translation: current

[English](./2026-10-09-e2ee-content-v2.md)

## 摘要

实验内容格式在每个加密 batch 中重复 JSON/hex 上下文和自报作者字段。Zixuan 授权改为二进制 v2，只传版本、代次、签名公钥、nonce、sealed 和签名；独立可信上下文参与派生、AEAD 与签名。实测内层固定开销为 141 字节，单 update 合成样例的 SDK 请求体从 577 缩为 244 字节（AAD 优化前为 297）。已验证回放能恢复撤权前的原始作者，只有快照且缺历史时明确只返回设备身份。这是实验内容格式的破坏性替换，不启用生产功能，也不自动迁移旧数据。

## 决策与职责

[双语内容规范](../../../../specs/e2ee-content.zh.md)规定精确字节、边界、用途码和密码学域。本记录部分替代[内容快照决策](../feature/2026-09-14-e2ee-content-snapshot.zh.md)和[快照准入决策](./2026-09-14-e2ee-content-snapshot-admission.zh.md)背后的内容格式与上下文描述；它们的 offset、租约、保存和发表约束继续有效。[Effect 迁移](./2026-10-09-e2ee-effect-v4.zh.md)边界不变。

格式不携带组织、资源、用途、用户、成员实例或 messageId。保留随机 nonce；旧 messageId 没有持久防重放存储。上下文包含原始 genesis、u32 大端代次、带长度的可打印 ASCII 逻辑资源和用途字节。派生、AAD 和签名使用独立且带版本的域。包中公钥只是已验证组织账本的查询候选，持有公钥不授予资格。宿主验签改为显式接收预期 scope；SDK 将原有 AAD 在密文外绑定至 AEAD 与签名，快照 continuationOffset 仍留在加密明文中，打开后返回原始内容字节。

历史作者索引属于私有保留的已验证回放状态，与状态一同复制，成员或设备删除时保留。genesis 和后续已验证登记填充索引，完整记录恢复会重建它。快照导入只恢复其中活跃设备的映射；只有历史登记事实而缺映射的公钥返回 `device-only/missing-history-context`，不能归给后来的成员实例。账本和账本快照 wire 均不加字段。新发表仍独立验权：Guest/R 不写，rotation 阻止诚实客户端新封装，异步密码操作后仍复核 authority。

派生密钥改用 Effect 资源释放器。typed 签名失败的回归检查发现 generator `finally` 没有擦除密钥。测试在成功、失败后重试以及显式中断 fiber 后检查工作 buffer，每次执行的 epochKey/明文副本也会清理。保留不可变输入支持重复与并发；不声称能擦除运行时或 WebCrypto 的所有隐藏副本。

## 编码长度实测

[测量程序](../../../../packages/e2ee-core/bench/content-packet-size.ts)使用真实 Loro export、真实 SDK 编码/读取和密码实现，通过注入 fetch 捕获 POST 请求体，并核对恢复文档。它还直接封装同一个 batch，区分内层与 SDK 包装。这里测量编码字节数，不是网络流量。

| 一个 batch 的 update 数 | 原始 updates | 编码 batch | v1 内层 | v2 内层 | v1 SDK 请求体 | v2 SDK 请求体 |
| ----------------------- | -----------: | ---------: | ------: | ------: | ------------: | ------------: |
| 1                       |           84 |         88 |     509 |     229 |           577 |           297 |
| 5                       |          424 |        444 |     865 |     585 |           933 |           653 |

单位均为字节。样例使用 64 位 hex 用户、32 位成员实例、64 位设备和 `doc-1` 资源。该样例 v1 开销为 421B；两组 v2 都精确为 141B。SDK AAD 在此为 51B；未引入逐条 operation 包装。

复现使用根 manifest 的 pnpm 版本。先用 `git archive` 将 `35bfca7e` 的已跟踪 v1 包导出到独立临时目录，接入其依赖，不复制 dirty 源码，再运行：

```sh
pnpm --filter @lody/e2ee-core exec node --import tsx bench/content-packet-size.ts /path/to/pristine-v1/packages/e2ee-core/src
```

省略路径只测 v2；旧源码不是随 v2 发布的第二套实现。

## SDK AAD 外部绑定优化

Zixuan 保留完整公钥与 64B Ed25519 签名，仅授权删除加密明文中重复的 SDK AAD。每包去掉 2B 长度与 51B AAD 副本。非空外部绑定使用带长度的独立 `aad-bound/v2` 与 `signature-bound/v2` 域；不使用外部绑定的通用 v2 不变。provider header 3/4 区分本修订与拒绝的旧 1/2，不增加字节。快照 offset 保留原有加密格式。宿主从结构验证后的 LSCE header 重建精确 SDK AAD 并独立验签；Lab insider reader 也传入此绑定。

| updates | batch | AAD 优化前 SDK body | 优化后 SDK body | 节省 |
| ------- | ----: | ------------------: | --------------: | ---: |
| 1       |    88 |                 297 |             244 |   53 |
| 5       |   444 |                 653 |             600 |   53 |

这是实际 SDK/密码往返的 POST body 长度，不含 HTTP/TLS。batch 之外的完整 update body 开销从 209B 降至 156B；内层仍为 141B。前表保留初版 v2 的测量结果。benchmark 的第三参数可给优化前源码快照指定标签（缺省仍标 v1）。保留旧 v2 SDK 流须用精确旧 reader；此修订使用新流/目录。不提供静默后备，不引入 deviceRef，不缩签名/nonce，不改 batch 策略。

AAD 后续验收：core 68 项、Lab 77 项通过，覆盖外部 AAD 缺失/改变拒绝、真实签名者给原密文换 AAD 重签后仍解密失败、可变输入捕获与并发/重复 Effect、宿主重建 AAD、旧 provider 拒绝、真实 HTTP 快照和进程崩溃恢复。类型、完整 Effect 边界及改动文件格式/lint 检查与下方初版全量结果分别记录。本次针对范围验收未重跑已知失败的全工作区，也未启用生产消费者。

## 兼容选择

新读端拒绝 v1 和未知版本。未选双读实现：包为私有实验，尚无产品内容启用，检查的 checkout 中没有持久内容 fixture。这不能证明外部 Lab `--data-dir` 或 repro pack 不存在。旧实验保留固定旧 reader；v2 使用新目录。显式迁移必须按独立 scope 核验、解密旧字节，保存原始签名，再由实际生成者向单独 staged stream 发表新快照。没有静默降级，也不改写其他生成者的签名含义。

可选 legacy 内容包历史 helper 跟随 v2。账本记录、epoch 信封、独立 72B 历史包和投递/回执协议不变。通用 blob/presence/RPC 用途有编解码与跨用途检查；完整产品消费者及生产 gateway 执行仍未实现。

## 验证与限制

- core 全量：548 通过、7 失败、1 跳过。剩余失败均在干净 `35bfca7e` 复现：反射构造未验证 LedgerView、4096 信封入口上限、发送 outbox 清理、中断 rotator 恢复、注入验签服务的信任边界、不可能的认证快照状态、journal 替换 endorser。这些是既有信任/恢复问题，不能据此宣称可生产发布。原来撤权设备自报作者的测试现改为从验证历史推导原作者并通过。
- Lab 全量：182 通过、3 失败。其中两个在 `35bfca7e` 复现：重复已提交记录处理、游标回退。第三个使用真实远程模型，未满足“攻击确实生效”的断言；确定性的协作、精确回放、宿主生命周期、内容准入和保存测试均通过。模型运行不能作为确定性验收，也未反复重跑以取得绿色结果。
- 行为覆盖：所有包组件篡改、跨组织/文档/用途及重签密文、错钥/缺钥、严格长度/版本/u32、Guest/R 新写拒绝、撤权历史、重新加入成员实例、仅快照作者降级、SDK update/snapshot 往返和 offset 替换、Effect 重复/并发/重试、中断清理、文档保存失败保留游标。
- core HTTP 快照使用已有 `LORO_STREAMS_CRDT` source override 指向相邻 SDK 源码，因为已发布 0.15.1 缺 continuationOffset；Lab 保持已有 vendored SDK。不改 manifest/lockfile，不宣称发布版 SDK 已支持快照。
- 最终集中验收 71/71 通过，包括用途绑定改动后的真实本地 HTTP update/snapshot 检查。两个包的类型检查、完整 Effect 边界检查、改动文件格式和带类型 lint 通过（lint 有 warning，无 error）。隔离 worktree 未初始化 ACP 子模块，根 public-boundary 检查无法解析这些 workspace 包；docs check 报告 20 个指向同一批缺失子模块的链接，改动文档没有 error。其 manifest 和依赖关系没有改。没有已登记的 SHA 保护主题，不伪造审阅记录或 Spec 批准。

未创建 PR、提交或部署生产，未做形式安全证明或穷尽外部数据盘点。持续实现分支从 `35bfca7e` 起步，保护原 checkout 未提交工作，也不改另一个会话的中央信箱协议。

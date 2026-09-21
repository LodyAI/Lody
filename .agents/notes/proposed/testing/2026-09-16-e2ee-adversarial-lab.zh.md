# 用确定性攻防实验室替代 E2EE 教程

Status: proposed
Translation: current

[English](2026-09-16-e2ee-adversarial-lab.md)

## 摘要

可视化教程增加了交互开发，却没有提供足够可复现的安全证据。替代实现已落在 `packages/e2ee-lab`：确定性正常协作、一个仅能使用 AttackLab 能力句柄的攻击 Agent、真实本地 Riverrun，以及无 LLM 重放。本文在审查前仍为 proposed。这不是恶意服务器无法中断服务的证明，也未启用产品 E2EE。

## 决策与范围

[Spec](../../../../specs/e2ee-adversarial-lab.zh.md) 定义契约；本文是唯一实施任务表和追加日志。本方案部分替代[独立 demo 提案](../architecture/2026-09-16-e2ee-independent-demo.zh.md)：保留后端/公开 API 边界和有效回归，替换浏览器与游戏交付方式。正常端使用确定性程序，只有攻击端使用 Agent。全序调度是测试方法，不是新增协议保证。采用普通 TS 纯计算、显式能力接口和局部 Effect 流程，不重写密码学，不采用 Rust 主控。

## 实施计划与唯一任务表

当前状态：HEAD `02b3f473`。本轮增量：第二份安全 review。不重做 D1–D8。不接入 Lody，不 push/PR/merge。协议/wire 变化只提案。

| 完成 | 阶段 | 门槛 |
| ---- | ---- | ---- |
| [x] | S1 compareNotes 同 head 冲突 | 同 genesis+head 但 length/digest 不同为 conflict；追平仍 pending-sync；真实签名快照 |
| [x] | S2 independent 证据 | independent 需要外带确认的签名者；不能只凭不同公钥或快照成员列表 |
| [x] | S3 换代候选先落盘 | CAS 前保存候选+精确记录；重启/丢 ACK 不重新生成；落败候选不是当前密钥 |
| [x] | S4 持钥证明绑定 | 复现错误归属；只交方案；不改 v1 wire |
| [x] | S5 epoch u32 / 快照资源 / 先验签 | 拒绝会截断的 epoch；限制宣称 length；昂贵导入前验签 |
| [x] | S6 其余归类 | 恶意历史包、canManage、openJournal、Convex、HKDF/X25519/legacy、Lean/产品 |

下表 D1–D8 为上一轮，勾选保留为历史证据。

当前状态：HEAD `04b90b58` 加上本轮 helper/过期/裁判补测。定向修复 design-probe 第 1–6、8 项。原子 Guest 准入（第 2 项协议）和旧代上传（第 7 项）只交方案、不改 wire。不接入 Lody，不 push/PR/merge。

| 完成 | 阶段 | 门槛 |
| ---- | ---- | ---- |
| [x] | D1 普通面与 harness | `/readyz` 不含 Riverrun/路径；NOW_HEADER 与未登录 failpoint 不能改宿主；harness token/DI 仍能 |
| [x] | D2 approveJoin 部分成功 | 第二步失败不得报 Guest/Admin 已完成；保留 pending；不是原子 Guest 准入 |
| [x] | D3 宿主加入过期 | 非空 `expiresAt` 在可信准入拒绝；过期前已提交的丢 ACK 重试仍能识别；纯校验不含时钟 |
| [x] | D4/D5 历史裁判 | 降级作者的历史仍合法；Loro+Flock；看导入事实不是后端能解开；未知为未测 |
| [x] | D6 未鉴权存在性 | 未登录访问已知/未知空间不再 401/404 分流 |
| [x] | D8 Admin ∩ canManage | helper 不暗示加入设备可管理；显式管理设备可以；机器不能 |
| [x] | D2/D7 待决策 | 只写方案，不改 wire |

下表为上一轮 R0–R7，勾选保留为历史证据。

当前状态：HEAD `4989fad8` 加上保留的脏工作树（宿主网关、裁判、设计探针）。上一轮唯一目标：独立复现包。不接入 Lody 产品，不改协议，不 push/PR/merge。实验室 Spec 仍为 draft。

| 完成 | 阶段 | 门槛 |
| ---- | ---- | ---- |
| [x] | R0 基线 | 记录 HEAD/脏树；保留已有网关与裁判改动；本表为唯一任务表 |
| [x] | R1 事件驱动执行 | 每次许可写入 schedule；自动推进规则是最早可运行 FIFO；显式并发用身份 `ScheduleDriver`；剩余 requested 报 `schedule.extra` |
| [x] | R2 独立复现包 | `e2ee-lab-repro/v1` 绑定脏树哈希、vendor/lock 哈希、private 0700；新进程 CLI 重放；缺私有材料/不支持的格式失败闭合；随机记录必须 `remaining()` 为空 |
| [x] | R3 精确比较 | multipart 只规范化分隔符；失败指纹含规则 ID；分别改顺序/载荷/随机尾项/判定都能定位字段 |
| [x] | R4 真实后端 | 保留 SIGKILL 崩溃矩阵；未刷盘 SQLite 页的断电丢失不建模 |
| [x] | R5 独立裁判 | 实验室参考模型不导入被测权限函数；跳过验签、cursor 先于文档、错误上下文 journal 走真实路径 |
| [x] | R6 缩减 | 有界 ddmin 去掉噪音，保持同一安全指纹，拒绝缩成 harness-error |
| [x] | R7 真实模型命中 | 破坏性命中只计 intercept 或 mutateBackend；observe/readBackend/submitClaim/finish 不算 |

下表为上一轮 S1–S4，勾选保留为历史证据。

| 完成 | 阶段 | 门槛 |
| ---- | ---- | ---- |
| [x] | S1 持续协作对照 | 建空间/邀请/分钥/双方持续编辑 Loro+Flock/Bob 离线编辑重连/Carol 中途加入读历史/撤权+换代/快照 bootstrap/丢响应恢复/进程崩溃重启/宿主重启收敛，全部固定脚本、无攻击通过 |
| [x] | S2 边界介入固定攻击 | 攻击者在协作进行中的已登记事件边界 intercept/readBackend/mutateBackend/submitClaim；命中证据可查（帧状态、回执、受影响结果） |
| [x] | S3 三目录无模型重放 | 同一攻击记录在三个全新 dataDir/clientDir 中按相同私有材料重放；事件、帧、客户端摘要、判定首分歧可定位 |
| [x] | S4 真实模型介入 | 至少一轮真实模型在协作进行中发起实际攻击（非仅 observe/finish）且命中；同一记录无模型重放一致 |

下表为此前阶段记录，勾选项见各阶段日志证据。

| 完成 | 阶段 | 门槛 |
| ---- | ---- | ---- |
| [x] | A 裁判观测 | 合法 admitDevice 不是 violation；后端多写且客户端拒绝不是客户端完整性失守；缺观测 → harness-error；恶意 Riverrun 下 guest 内容 → outside-model |
| [ ] | B 真实落盘 | document-persisted 写出文档字节；cursor-persisted 在文档之后写游标；崩溃重启不跳过未读数据 |
| [ ] | C 同一攻击重放 | 成功 xor 的 needle 在恢复的私有材料下仍命中；改回执/字节会报首次分歧 |
| [ ] | Effect 组合 | 一套 submit/delivery Effect；Promise 仅包装；取消不丢 pending |
| [ ] | 调度交付 | 读/写/落盘/结果交付等待许可；暂停/取消清理 waiter |
| [ ] | 缓存/环境 | 按实例 SigningPointCache；未注入的时钟/Wasm 列为重放限制 |

| 完成 | 阶段           | 交付物                         | 必须通过的门槛                              |
| ---- | -------------- | ------------------------------ | ------------------------------------------- |
| [x]  | P0 基线        | 版本、备份、迁移清单、现状结果 | 用户未提交工作可恢复，回归覆盖有去向        |
| [ ]  | C1 显式依赖    | 纯计算边界、能力接口、兼容草图 | E1–E3，真实验签一致，随机/时钟来源完整      |
| [ ]  | C2 Effect 试点 | 唯一 submit/resume 实现        | E4–E7，CAS/丢 ACK/中断/重启正确             |
| [x]  | C3 其余流程    | 分钥、恢复、准入与资源管理     | E3–E6，权限重查与原始截止不回退             |
| [ ]  | P1 常驻协作    | lab 包、真实后端、三副本       | 离线重连与耐久恢复，不是一次性读写          |
| [ ]  | P2 确定性      | 调度器、记录、重放             | 三次新目录重放一致，首分歧可定位            |
| [x]  | P3 固定攻击    | Spec 场景矩阵、有效裁判        | 真实改库被检验，注入已知缺陷时裁判失败；guest 内容 → outside-model |
| [x]  | P4 Agent       | 受限 API、自由攻击记录         | 隔离自测通过，至少一轮真实 Agent 运行可重放 |
| [ ]  | P5 交接        | 干净检出验收、旧 demo 删除     | 下述完成定义逐项通过，未通过项显式保留      |

### P0：冻结基线，不先删掉证据

1. 记录 HEAD、脏文件清单、Node/pnpm/Effect 版本、lockfile 和 streams-crdt tarball 哈希。沿用 Effect 3.18.4、Riverrun 0.3.0；升级另列理由与验证。
2. 对旧 demo/game 已跟踪与未跟踪工作做可恢复备份，记录恢复路径。不得提交真实密钥或运行秘密；不得把无关 core bench/test、Electron 修改卷入清理。
3. 跑现有 core/demo typecheck 与行为测试，记录原始结果、跳过和环境失败；不能把既有失败改名为通过。建立“旧用例 → 新用例/保留位置/删除理由”表。
4. 输出副作用清单：入口、实际依赖、控制方式、残余非确定性。只盘点公开使用路径及其依赖，不趁机重写所有 legacy 模块。

### C1：先证明能力接口足够小且可控

先补测试，再重构。目标文件是 `ledger/ledger.ts`、`ledger/crypto.ts`、`content.ts`、`ledger/keys.ts`、恢复/身份路径以及 `streams-fetch.ts` 的实际依赖。

- 保留公开调用兼容；提交一页类型草图，列出纯入口、Effect 入口、能力归属与默认真实实现。默认适配负责安全随机源和真实时钟，测试层显式替换；不让调用方手工挑 nonce。
- 把 Node Worker/环境检测移出纯验证路径；若保留并行适配，必须与单线程对合法、非法及嵌套证明给出相同结论和错误位置，不引入公开跳过验签接口。
- 缓存按实例隔离、可禁用并设上限。对相同输入检查结果/错误一致、调用者字节与旧状态未被修改；本地临时缓冲区清零不视为应删除的副作用。
- 统一时间读取与调度/取消定时器，测试过期前、恰好过期、过期后和时钟回退；凭证窗口不能被重新计时。
- 分别核对 WebCrypto keygen、nonce、HPKE encapsulation、Loro/Flock peer ID/时钟。完整密钥生成可记录生成后的私有材料用于重放，但验签/解密仍真实执行；不得用录好的验证结果绕过计算。无法注入的依赖记录具体缺口，不能靠全局 monkey patch 宣称完成。

验收：公开 API 类型用例通过；已有密码学/账本行为测试不回退；新增边界测试通过。E1–E3 的每个来源都有证据，未解决 HPKE/Wasm 随机源时可继续无关任务，但不能勾对应重放项。

### C2：只迁移账本提交与恢复，先跑最小闭环

范围以 `ledger/submit.ts`、`LedgerStore`、`LedgerStream` 为中心。抽出可以独立判断的状态转换，用 Effect 编排其余真实操作；Promise API 只是薄包装。测试用可调度端口，随后通过真实 Riverrun 再验一次。

必须通过：

1. pending 保存失败 → 后端没有追加；发送前重启 → 用原字节恢复。
2. 后端已提交、ACK 丢失/请求中断 → 结果保持未知，重启读回确认一次提交，不能重签。
3. 两客户端都读旧 head → 真实 CAS 竞争，只有一个从该 head 成功；冲突者不自动创造另一个操作。
4. 读到非法记录 → 返回明确错误，不更新已认证状态或越过非法记录的 durable cursor。
5. 正常取消释放资源；强制终止进程后从真实 SQLite 重开，不靠 finalizer 修复状态。
6. 公共 Promise 与 Effect 入口在同一夹具下产生相同协议字节、状态和错误语义。

失败、冲突、结果未知、主动中断、框架缺陷须区分；不能统一 catch 后重试。C2 通过前不批量迁移整个包。

### C3：扩展到其余副作用流程

- 将被使用的分钥 outbox、恢复编排、快照准入接到同一能力体系；纯 codec/policy 不 Effect 化。Node 文件/SQLite 和网络实现仍是真实适配器。
- 验证分钥保存后重发的字节一致，历史密钥承诺照常检查；恢复不复用旧普通设备私钥，不扩展当前恢复产品承诺。
- 在异步验签期间撤销权限/推进时钟，确认最终检查生效；存储 busy 不抢锁、不丢数据、不延长 lease。检查与同步提交之间不能加入实验用暂停点。
- 注入获取/操作/释放失败及正常取消，确认连接、锁、Worker 释放且未泄密。长网络等待可中断，关键短提交区和 pending 恢复语义单独处理。

### P1：把旧 demo 的有效行为迁为常驻客户端

在 `packages/e2ee-lab` 建立最小目录：`scheduler`（纯状态机）、`runtime`（Effect 组装）、`actors`、`backend`、`attacks`、`judge`、`trace`、`scenarios`、`cli`；不为每项新开一个包。

每个客户端拥有独立常驻 Loro/Flock 对象、设备状态、本地持久化与 cursor。Loro 与 Flock 分流，peer 身份不能在并发写者间共用。引入先落盘文档再落盘 cursor 的边界；未解决依赖不能推进 cursor/发布快照。用真实 Node Riverrun，保留后端正常鉴权模式和恶意数据模式。

先运行三人连续编辑、离线重连与重启的基线，再覆盖邀请、分钥、撤权/换代。README 定义启动、脚本运行和后续 replay 命令；根命令不依赖 UI 构建。

### P2：可暂停、可记录、可重放

- 为每个 actor/operation/phase 注册稳定事件；副作用启动前等待许可，完成通知不决定全局顺序。暂停一方时允许另一方推进；未请求的操作不能偷偷写入。
- 用有限 TS 模型枚举两 actor、提交前/已提交/已回执、中断/重启的有界交错，检查“不许可不执行、事件只消费一次、未知提交不重复创造”。写出枚举边界，再与 C2 真实结果对照；模型不是密码学证明。
- 控制虚拟时间、网络投递、SDK 重试和存储边界，实际后端字节仍来自真实操作。持久化本来原子的部分不拆成测试伪事务。
- 私有随机材料与公开场景 seed 分开；重放逐次校验随机请求标签/长度、事件及协议字节，不匹配立即报首分歧。私有客户端状态摘要也不放入攻击者观察，避免低熵明文被枚举。
- CAS 竞争、丢 ACK、真实密文修改场景分别在三个全新目录重放；故意改变一项调度/随机请求，确认检查器不是只比较最终文本。

### P3–P5：攻击覆盖、真实 Agent 与交接

P3 完成 Spec §7 全表，每项都有正常对照、攻击输入、预期边界和实际判定。利用测试专用已知缺陷确认裁判能发现泄漏、未授权接纳、cursor 越进；不让服务端 403 替代恶意服务器模式下的客户端检查。对不同 head 先同步、同位置状态冲突、合法历史快照和缺少独立证据的分叉分别报告。

P4 在启动 Agent 前验证：只能访问攻击 API/受限后端，不能读取诚实客户端和私有复现包，不能改裁判。依赖外部模型不可用是 P4 的外部阻塞，不阻止完成固定攻击与重放。预算耗尽不算发现漏洞，也不算安全证明。至少一份真实 Agent 攻击记录须无 LLM 重放；如果确有漏洞，保留最小反例，否则明确“本轮未发现”，不能制造成功结论。

P5 从干净检出运行 README 和核心/实验室全部检查。按 P0 映射删除旧 demo/game 包、专属依赖、资源、命令和过时设计，修复链接，保留新实现所需的后端与依赖来源。只有行为覆盖迁移后才能关闭清理任务。更新最近 AGENTS/README，但不声称 Effect 提供 OS 隔离或整个包都是纯函数。

### 验收命令、证据与完成定义

已落地命令：`pnpm --filter @lody/e2ee-core check`、`pnpm --filter @lody/e2ee-lab check`，以及 README 的 `scenario:collab` / `replay` / CLI。根别名：`pnpm test:e2ee-lab`、`pnpm lab:e2ee`。旧包 `@lody/e2ee-demo` 已删除。另跑公开入口兼容测试、依赖边界检查、格式检查、`pnpm run docs check`；提交前按根 AGENTS 运行仓库检查。

每阶段只记一条总结：SHA/工作树标识、命令、退出码、证据路径、通过的契约、未通过项。原始日志保存在受控运行目录；本文不粘贴长日志或秘密。失败属于环境、模型外限制还是实现缺陷必须说清楚。

全部完成必须同时满足：E1–E8；正常协作和全攻击矩阵；真实 Agent 至少一轮及三次确定重放；隔离自测；公开 API 兼容；旧 UI/game 清理关闭；干净检出复现；没有未处置的 P0/P1。文档格式检查不替代这些证据，不宣称数学安全证明或产品接入完成。

已选方向下的文件名、service 命名、测试拆分由执行者自行决定，不为这些重复等待人工批准。只有改协议/权限/信任模型、打破公开兼容、向攻击者泄露秘密、或削弱验收才需要先确认。审查发现问题后按同一契约做最小修复，不能新造无关门槛。记录 blocker 后先完成不受影响任务；不把 push/merge 或额外的人类签字设为本地交接的完成条件。

## 执行日志——在这里追加

### 2026-09-16 — 设计落盘

- 新增双语范围、威胁边界、事件/重放契约、接口草案和分阶段验收。
- 当前工作区包含未提交的游戏修改及无关核心/Electron 工作；本轮未删除、迁移、实现、提交或推送。
- 已核对旧 demo manifest：Riverrun 0.3.0、file-pinned streams-crdt。确定性 hook 和真实隔离仍待实现验证。
- 尚未执行有限模型或安全场景；文档检查不证明安全。
- 后续记录包含：阶段、精确版本/命令、发现、约束、计划调整、阻塞/待决策、结果。禁止追加私钥、秘密复现包或捕获的 Agent 对话。

### 2026-09-16 — 为 Effect 讨论盘点核心副作用

- 源码核对，不是已执行安全验收：`ledger/ledger.ts` 在任务至少 32 条时按进程/环境变量自动选择 Node Worker，与账本纯执行边界的目标存在差距；`extend` 则克隆状态后在本地执行确定性验签/权限逻辑。`ledger/crypto.ts` 另有模块级公钥点缓存及 noble 哈希实现赋值。
- `content.ts` 部分注入加密平台，但在异步操作前后调用实时授权；`ledger/keys.ts`、恢复文件/设备、用户身份函数仍使用全局随机数或原生密钥生成。HPKE 封装内部随机来源需单独核对。外包一层 Effect 无法自动接管这些内部操作。
- `LedgerClient` 已注入存储和流接口；快照准入已注入时钟、权限和存储；`streams-fetch.ts` 虽注入 now/fetch，定时器仍为全局调用。Node 存储模块负责真实 SQLite/文件副作用。
- 建议保留普通确定性编码/哈希/权限函数，显式管理 Worker 选择和缓存归属，统一加密随机源、时钟/定时器及实时授权依赖；考虑用 Effect 管理提交、分钥、准入和资源生命周期。保留提交结果未知时的恢复、先持久化 pending 再发送、最终权限复查及同步检查/提交边界，不能在最终授权检查与受保护操作之间新增异步调度点。
- 尚未迁移 Effect 或更改 API；实施前确认范围与公开 API，不隐含协议修改或生产默认使用确定性随机源。

### 2026-09-16 — Effect 方向确认，实施计划展开

- 将普通 TS 纯计算、显式能力接口、局部 Effect 编排写入 Spec E1–E8；保持协议和安全模型不变。
- 在原 P0–P5 中加入 C1–C3 核心重构阶段，将唯一任务表放在本文；先验证 submit/resume，再扩展。历史日志保留，旧“P0–P5 在 spec 维护”的分工由本条替代。
- 当前只有文档变更，所有实施任务未勾选。有限模型、行为与重放验证留给对应实施阶段，未宣称已经通过。

### 2026-09-17 — 保留有效遗留工作，清理工作区

- 整个脏工作区（包括未跟踪文件）已备份到本地 Git stash `5d04e3d42f173c7631afdcbe5f2426979ffdd31a`（`backup/e2ee-workspace-cleanup-2026-09-17`）。未完成的游戏改动、无关 Electron 格式修改和偶然锁文件变动已移出工作区，可从备份恢复。已提交的 demo 基线保留，等 P5 迁移行为覆盖后再删除。
- 保留公开 LedgerClient 一万条记录的持久化/容量回归测试、权限模型对应修正，以及 README 和包命令已经引用的 benchmark 源码/Wasm 样本。删除源码字符串断言，保留真实行为检查。纠正 probe 的 SIMD 声明：运行时支持和编译标记不能证明实际执行 SIMD，更不能证明与核心验签策略等价。已撤回的 100ms 门槛不恢复。
- 验证：核心 `check` 通过（34 个文件、372 项测试；一万条测试约 130 秒）。清理编辑后，对应测试复跑通过，后端 probe 以 `--n=32` 跑通，包含 Worker。核心包格式化通过。根 `pnpm check` 通过类型检查，但在 `packages/e2ee-demo/src/host.ts` 已有的未使用 `Server` 导入处停止，该命令后续的全仓测试未执行。本轮不代表启用产品、迁移 Effect、实现实验室、push 或任何阶段验收。

### 2026-09-17 — P0 基线冻结

- HEAD `5bd0e60ebf9770316f27587d68726c25915b8fec`，设计基准 `0bf0fc24`，分支 `feat-e2ee-core`。工作树在本阶段开始时干净。Node v24.21.0，pnpm 10.20.0，Effect catalog 3.18.4，demo Riverrun 0.3.0。lockfile SHA-256 `eb169cb2ef2fcc13de10e18c43938fa11456c1993e2fee529870c14060503f1c`；`packages/e2ee-demo/vendor/streams-crdt.tgz` SHA-256 `a1314d8fbfaed381505001342d563993ae1f32c0682d9db8252c6f6eb97a391e`。
- 可恢复备份仍为 stash `5d04e3d42f173c7631afdcbe5f2426979ffdd31a`（`backup/e2ee-workspace-cleanup-2026-09-17`）。原始命令输出在 `.agents/runs/e2ee-lab/p0/`（已 gitignore）。
- 基线命令：`pnpm --filter @lody/e2ee-core check` 退出 0（34 文件 / 372 测试）。`pnpm --filter @lody/e2ee-demo typecheck` 退出 0；`pnpm --filter @lody/e2ee-demo test` 退出 0（41 通过，2 跳过：`d2-browser` 需 `LODY_E2EE_DEMO_BROWSER=1`）。未把既有失败改名为通过。根 `pnpm check` 的 demo lint 问题仍在 `host.ts` 未使用 `Server` 与 `Inspector.tsx` 变量遮蔽，本阶段不改无关 UI。
- 旧用例去向：`d0-start`/`d1-control`/`d2-invite`/`d3-content`/`d4-revoke`/`d5-matrix`/`browser-persist` 保留到 P1/P3 迁入 lab 后；`d2-browser`/`ui-session` 随 UI 在 P5 删除；`pin` 若仍约束 host 则迁 lab，否则 P5 说明后删除；`helpers.ts` 中真实 Riverrun/host 适配迁入 `packages/e2ee-lab/backend`。无关 Electron/core bench 不纳入清理。
- 副作用盘点（公开路径）：`Ledger.verify` 曾按 `process.env`/`worker_threads` 自动并行；`crypto.ts` 模块级点缓存；`keys.ts`/`recovery-file.ts` 用 `crypto.getRandomValues`；`user-identity`/`recovery-device` 用 WebCrypto `generateKey`；`streams-fetch.ts` 用全局 `setTimeout`；`content.ts` 与 snapshot admission 已注入平台/时钟。HPKE `@hpke/core` 1.9.0 DHKEM 临时钥无法注入；Loro/Flock peer/Wasm 时钟属库内部，P1 再列。noble `hashes.sha512` 模块初始化不是公开验签旁路。

### 2026-09-17 — C1 显式能力接口

- 类型草图：`packages/e2ee-core/src/capabilities.ts`。纯入口：`Ledger.verify`/`extend`/`prepare`、编解码、哈希、权限。能力：Entropy、Clock、TimerSchedule、CryptoPlatform、SignatureVerifyExecutor、SigningPointCache。默认 `liveEntropy`/`liveClock`/`liveTimerSchedule`/`sequentialSignatureVerify`。Node 并行：`createNodeSignatureVerifyExecutor`（`./ledger-node`）。Effect 入口留给 C2 的 submit/resume。调用方不必选手动 nonce。
- 行为：`Ledger.verify` 默认单线程，不再读 `LODY_E2EE_VERIFY_WORKERS`。缓存按实例可禁用/设上限。`sealHistoryPacket`/`createRecoveryFile`/`sealRecoveryBackup` 接受 Entropy；`createBoundedStreamsFetch` 接受 `scheduleTimer`；身份/恢复设备生成接受 CryptoPlatform。
- 证据：`test/capabilities-boundary.test.ts`；`pnpm --filter @lody/e2ee-core exec vitest run --exclude test/ledger-long-chain.test.ts` 退出 0（34 文件 / 377 测试）。公开 consumer 与既有 keys/streams/freshness/ledger 测试通过。未解决：HPKE 封装内部随机、Loro/Flock Wasm 随机/时钟；对应重放项不能勾选。未启用产品 E2EE，无 push/PR。`test/ledger-long-chain.test.ts` 在 C1 后单独退出 0（约 110s）。

### 2026-09-17 — C2 submit/resume Effect 闭环

- 沿用 Effect 3.18.4（catalog），`@lody/e2ee-core` 新增依赖。纯判定在 `submit-decision.ts`；`LedgerClient.submit`/`resume` 是同一 `submitSteps` 的 `runPromise` 薄封装。pending 保存包在 `Effect.uninterruptible` 内；CAS 等待可中断。Promise `LedgerStore.exclusive` 适配器内部仍有一次 `runPromise`，不是每条网络请求新建 runtime，也不构成第二套 submit。
- 必须项：pending 保存失败不 CAS；persist 后 save 故障保留原字节并 resume 提交；false ACK 保持 pending、不重签；两客户端 CAS 只有一方成功；非法页不推进 cursor；SQLite 杀进程后锁释放/pending 保留（既有 node-store 测试）；Promise 与 Effect 提交同一记录得到相同 status 与协议字节。
- 证据：`pnpm --filter @lody/e2ee-core exec vitest run --exclude test/ledger-long-chain.test.ts` 退出 0（381 测试）；`pnpm --filter @lody/e2ee-demo test` 退出 0（真实本地 Riverrun，41 通过 / 2 跳过浏览器）。
- 限制：外层 Fiber 中断不会自动 abort 已进入 `exclusive` 的底层 `appendCas` Promise（E6：中断≠撤回）。HPKE/Wasm 随机源仍未注入。未做实验室调度器，未启用产品 E2EE。

### 2026-09-17 — C3 分钥/准入接到同一能力体系

- `LedgerKeyDelivery.send` 与 `sendEffect` 共用实现；Promise 入口用 `runPromiseThrow` 解开 FiberFailure，调用方仍看到 `LedgerError`。保存后重发同一密文、二次授权失败不 put、撤销后不发送：既有 delivery 测试 + Promise/Effect 对照。
- 快照准入已注入 `now`，验签期间时钟推进/原截止不延长：`test/snapshot-admission.test.ts`。恢复设备/文件走 C1 CryptoPlatform/Entropy，两进程恢复：`test/ledger-recovery-process.test.ts`。SQLite busy/杀进程：既有 publication/node-store 测试。
- 证据：`pnpm --filter @lody/e2ee-core exec vitest run test/ledger-delivery.test.ts test/ledger-submit.test.ts` 退出 0。恢复流程仍是 Promise 适配器上的 Effect 薄包装，没有第二套模拟实现。未引入跨流事务。

### 2026-09-17 — P1 实验室包与三人常驻协作

- 新增 `packages/e2ee-lab`。第一版 backend/actors 复用 `@lody/e2ee-demo/host` 与 `DemoSession`（真实 sqlite Riverrun）。调度器目前只记录事件，不执行副作用；暂停/放行在 P2。
- `test/collab-baseline.test.ts`：Alice 建空间，Bob/Carol 入账本，Alice/Bob 真实 Loro 编辑，Bob 用同一 clientDir/device 重连，host 关停后在同一 dataDir 再开，Alice/Carol 读回成员数与文档。`pnpm --filter @lody/e2ee-lab check` 退出 0（2 文件 / 2 测试）。
- 限制：Carol 尚未走分钥/内容写入（多信封同页拆分留给后续）。lab 仍依赖 demo host，P5 再迁。无重放、无攻击 Agent、未启用产品 E2EE。

### 2026-09-17 — P2 调度许可与事件形状重放（未勾选）

- 调度器现为 `request → permit → complete`。未许可不能 run；同时只允许一个 permitted；事件只消费一次。有限两 actor submit 交错探索 `exploreSubmitInterleavings` 通过。`firstDivergence` 在改 actor 时报告 index 0。
- `test/replay-cas.test.ts` 在三个全新 dataDir 上跑真实 Riverrun CAS 竞争，事件形状一致，故意改调度可定位首分歧。`pnpm --filter @lody/e2ee-lab check` 含该测试后待提交。
- 未勾选 P2：诚实客户端密钥生成仍用安全随机，协议字节不能仅靠公开 seed 重放；丢 ACK 与密文篡改的三目录字节重放未做。DemoSession 尚未注入 lab Entropy。

### 2026-09-17 — P3 裁判与真实控制篡改起步（未勾选）

- `judgeImport` 在缺陷导入器接受非法记录时给出 `violation`。`appendControlRecord` 对真实 host 提交篡改签名，后端拒绝，账本长度仍为 1。`pnpm --filter @lody/e2ee-lab exec vitest run test/attacks.test.ts` 退出 0。
- 未勾选 P3：Spec §7 全表、Riverrun 停机改库、已知缺陷注入到验签路径、恶意服务器分叉报告均未完成。

### 2026-09-17 — P2 协议字节重放验收

- DemoSession 增加可选 `entropy`/`fetch`；生产默认仍是 live entropy 与全局 fetch。实验室 `LabRuntime` 在 `append-cas` 前 `gate`，手动许可决定 CAS 顺序；暂停一方时另一方仍可被许可。
- 私有复现材料：导出的设备 PKCS8 + 带标签熵填充 + 协议请求字节。公开场景 seed 不混入密钥。重放导入设备并重放熵，验签/解密仍真实执行。
- 证据：`pnpm --filter @lody/e2ee-lab test` 退出 0（7 文件 / 14 测试）。`test/replay-bytes.test.ts` 在三个新目录重放 CAS（相同 winner head 与帧）、丢 ACK resume、停机 xor Riverrun sqlite；改 actor/请求字节/熵立即报 `firstReplayDivergence`。`test/runtime-permit.test.ts`：先许可 Alice，Twin 冲突。有限模型对照 C2：unknown CAS 后只走 ack/resume，不新造 pending。
- 限制：HPKE 封装内部随机仍不可注入，故 HPKE 信封不在本轮字节重放范围内。进程内不跑 `kill-after-commit`（会杀掉测试进程）；该路径仍由 demo D5 spawn 覆盖。未启用产品 E2EE。

### 2026-09-17 — P3 Spec §7 矩阵与真实改库验收

- `test/matrix.test.ts` 每项含正常对照、攻击输入、预期边界、实际判定：已知缺陷导入器 → `violation`；host 拒签；恶意服务器直写 Riverrun（不以 403 代替客户端检查）；未授权设备；丢 ACK；后端明文扫描；撤权；恢复备份篡改；快照同 offset 冲突；伪造对账纸条；无独立证据的分叉 → `outside-model`；停机 xor sqlite。
- 证据：同上 lab test 退出 0；`pnpm --filter @lody/e2ee-demo test` 退出 0（41 通过 / 2 跳过浏览器）。
- 未做 P4 真实 Agent。实验室仍依赖 demo host，P5 再迁删。

### 2026-09-17 — P4 受限 AttackLab 与可重放 Agent 运行验收

- `createAttackLab` 是 Agent/CLI 的 Promise 边界，内部只有一套 Effect 实现。期望明文和客户端目录放在 WeakMap；`observe` 只返回公开事件、genesis hex、后端大小和错误类别。隔离就是这个能力句柄，不是双进程、目录前缀、提示词或 OS 容器。Effect 不是沙箱。
- 隔离自测：`JSON.stringify(lab)` 为 `{}`；可枚举自有名是八个方法加 `actions`；observe JSON 不含期望明文或 `clientDir`；未知 `eventId` 抛 `invalid-event`；xor 找不到 needle 返回 `{ok:false}`。
- 真实 Agent 运行：本会话只使用 AttackLab。`exploreAttackLab` 观察、读取 Riverrun、扫描 ASCII，若无泄漏则在 sqlite 头之后 xor 16 字节，再提交错误明文声明。本轮未发现（`confidentiality: pass`）。`replayAttackActions` 无 LLM 重放同一动作日志，公开判定一致。`XAI_API_KEY`/`GROK_API_KEY` 未设置，未调用外部模型。
- 证据：`test/attack-lab.test.ts`。`pnpm --filter @lody/e2ee-lab check` 与 P5 一并记录。

### 2026-09-17 — P5 交接、旧 demo 删除、README 复现验收

- host/session/device/persist/backup 迁入 `packages/e2ee-lab/src/platform/`。vendor tarball SHA-256 `a1314d8fbfaed381505001342d563993ae1f32c0682d9db8252c6f6eb97a391e`。`git rm -r packages/e2ee-demo`；宿主上残留的 UI 文件服务已删除。根脚本 `lab:e2ee` / `test:e2ee-lab`。线路/兼容字符串 `x-e2ee-demo-*` 与 `e2ee-demo-backup/v2` 仍作为协议常量保留。
- P0 用例去向：`pin` → `test/host-lifecycle.test.ts` tarball 钉扎；`d0-start` → healthz/重启/CLI SIGTERM/kill-after-commit；`d1-control` → 未加入 POST/DELETE 加上协作 genesis 与矩阵未授权；`d2-invite` → `collab-baseline`；`d3-content` → Loro 协作加 `test/flock.test.ts`；`d4-revoke` / `d5-matrix` → `test/matrix.test.ts` 加 kill-after-commit spawn；Node persist 由同一 `clientDir` 重连覆盖；`d2-browser` / `ui-session` / 浏览器 localStorage 随 UI 删除。
- 可玩教程 Spec 为 `outdated`。独立 demo 说明摘要记录实验室已替换 demo UI。实验室 Spec 仍为 draft。
- 证据：`pnpm --filter @lody/e2ee-lab check` 退出 0（10 文件 / 23 测试）。`pnpm --filter @lody/e2ee-core check` 退出 0（35 文件 / 384 测试）。`pnpm run docs check` 退出 0（errors 为空；既有无关 AGENTS 体积警告）。干净检出替代：未 `git reset --hard`、未开额外长期 worktree；README 命令在脏的 `feat-e2ee-core` 工作树、父提交 `ed331f61` 上运行。Node v24.21.0。
- 限制未变：HPKE `@hpke/core` DHKEM 随机与 Loro/Flock Wasm 随机/时钟仍不可注入；Fiber 中断不会 abort 已进入 `exclusive` 的 `appendCas`；隔离不是 OS 级。未启用产品 E2EE；无 push/PR/merge。

### 2026-09-17 — P5 干净工作树 README 复现

- `fa7cb978` 工作树干净。未 `git reset --hard`、未开第二棵 worktree，重跑 README 命令。
- `pnpm --filter @lody/e2ee-lab check` 退出 0（10 文件 / 23 测试）。`scenario:collab` 退出 0。`replay` 退出 0（4 测试）。CLI `--data-dir` 在 loopback 监听，`/healthz` 返回 `200 ok`，SIGTERM 退出。`pnpm --filter @lody/e2ee-core check` 退出 0（35 文件 / 384 测试）。
- 仍未启用产品 E2EE。无 push/PR/merge。

### 2026-09-17 — Spec §5 intercept/未满足与 15 分钟截止

- `advanceUntil` 在阶段未出现时返回 `unmet: true`。拦截种类为 `drop | replace | delay | duplicate`。drop 表现为丢 ACK（`status: unknown`）；delay 把 CAS 回执留到第二次调度许可，不用墙上时钟 sleep。duplicate 把 CAS 请求发两次。重放按记录的拦截种类执行，不再一律当成 drop。
- 15 分钟凭证截止：把注入的客户端时钟推到 `issuedAt + MAX_LEASE_MS` 后，后续控制读取被拒绝（`now == expires` 视为过期）。
- 证据：`pnpm --filter @lody/e2ee-lab check` 退出 0（10 文件 / 27 测试）。HPKE/Wasm 随机、Fiber/`exclusive` 中断、OS 隔离仍未注入。未启用产品 E2EE。无 push/PR/merge。

### 2026-09-17 — 经库 ekm 注入 HPKE DHKEM IKM

- 生产路径 `sealEpochEnvelope` / `KeyEnvelopeCipher.seal` 仍省略 `ekm`，`@hpke/core` 使用实时 WebCrypto `generateKeyPair`。测试可传入 Entropy；32 字节标签 `hpke-dhkem-ikm` 交给库文档中的 `ekm` DeriveKeyPair 钩子。同一 IKM 得到相同帧且仍能打开；不同 IKM 不同。不是重写密码学，也不是全局 WebCrypto patch。
- AttackLab `duplicate` 拦截：第一次 CAS 提交成功，账本长度为 2。
- 证据：`pnpm --filter @lody/e2ee-core exec vitest run --exclude test/ledger-long-chain.test.ts` 退出 0（34 文件 / 382 测试）。`pnpm --filter @lody/e2ee-lab check` 退出 0（10 文件 / 28 测试）。Loro/Flock Wasm 随机/时钟、Fiber/`exclusive` 中断、OS 隔离仍未注入。未启用产品 E2EE。无 push/PR/merge。

### 2026-09-17 — 用 Entropy 绑定 Loro/Flock peer ID；撤权后延迟上传

- 实验室 `writeLoro` / `writeFlock` 通过库的 `setPeerId` / `new Flock(id)` 绑定 peer ID，Entropy 标签为 `loro-peer-id`（8 字节 bigint，0 变为 1）和 `flock-peer-id`（hex）。Wasm 物理时钟仍是库内部。ContentCipher nonce 仍用实时 WebCrypto（试注入 platform 会弄坏 payload sealing）。
- `deliverEpochKey` 把会话 Entropy 传入 `sealEpochEnvelope`，实验室提供时 HPKE IKM 带标签。
- `admitDevice` + 分钥 + 撤权后的延迟内容写被宿主拒绝（`test/host-lifecycle.test.ts`）。
- 证据：`pnpm --filter @lody/e2ee-lab check` 退出 0（10 文件 / 30 测试）。Fiber/`exclusive` 中断与 OS 隔离仍按 E6 / 能力句柄隔离不注入。未启用产品 E2EE。无 push/PR/merge。

### 2026-09-17 — ContentCipher nonce 注入与跨文档替换

- ContentCipher 的 messageId/nonce 使用注入的 `getRandomValues`。实验室通过闭包调用 `session.random` 填充 `content-csprng:<n>`（先前拆出未绑定方法导致 sealing 失败）。同一 16 字节 messageId + 24 字节 nonce 得到相同信封（`test/content.test.ts`）。生产仍用实时 WebCrypto。
- 恶意服务器把 Loro 流字节抄到 Flock 流后，不会作为 Flock 明文出现（不含 `cross-secret`）。
- 证据：`pnpm --filter @lody/e2ee-core exec vitest run test/content.test.ts` 退出 0（13 测试）。`pnpm --filter @lody/e2ee-lab check` 退出 0（10 文件 / 31 测试）。Wasm 物理时钟、Fiber/`exclusive` 中断、OS 隔离仍未注入。未启用产品 E2EE。无 push/PR/merge。

### 2026-09-17 — 先持久化文档再写 cursor；崩溃后幂等追赶

- 真实 Riverrun：`beforeRemoteCursorSave` 导出 Loro 快照后 cursor `save` 抛错。从旧 cursor 重启能从服务器恢复 `durable-after-cursor-crash`。第二次同步恢复该快照和已保存 cursor，文本一致（重复导入幂等）。空文档配已推进 cursor 不能作为恢复，符合 streams-crdt cursor 契约。
- 证据：`pnpm --filter @lody/e2ee-lab check` 退出 0（10 文件 / 32 测试）。Wasm 物理时钟、Fiber/`exclusive` 中断、OS 隔离仍未注入。未启用产品 E2EE。无 push/PR/merge。

### 2026-09-17 — 换代、历史解包、撤权后仍可读历史

- 实验室 `publishEpoch` 后 `recoverEpochHistory` 从最新密钥恢复 epoch 0 和 1。撤掉额外设备后，所有者和被撤客户端仍能读 epoch-0 Loro 文本（已分发密钥不收回）。被撤客户端不能追加。所有者再写 epoch-1 内容，两个 epoch 都仍可读。
- 证据：`pnpm --filter @lody/e2ee-lab check` 退出 0（10 文件 / 33 测试）。Wasm 物理时钟、Fiber/`exclusive` 中断、OS 隔离仍未注入。未启用产品 E2EE。无 push/PR/merge。

### 2026-09-17 — 拒绝角色提升；作者撤权后快照仍可 bootstrap

- 已加入成员把自己 `setRole` 成 admin 被拒绝，已认证角色仍是 `member`。
- 非所有者设备上传已接纳的 Loro 快照。所有者 bootstrap（GET `/snapshot` 或 `/bootstrap`）。该设备被撤后，所有者仍能 bootstrap 同一明文。线上快照字节不是明文。
- 证据：`pnpm --filter @lody/e2ee-lab check` 退出 0（10 文件 / 35 测试）。Wasm 物理时钟、Fiber/`exclusive` 中断、OS 隔离仍未注入。未启用产品 E2EE。无 push/PR/merge。

### 2026-09-17 — 伪造加入、访客写、跨 Org Loro 替换

- 翻转过的加入请求签名不会被接纳，成员数仍为 1。访客 `canWriteDocument` 为 false，`writeLoro` 抛错。把 Org A 的 Loro 流字节经 Riverrun 抄到 Org B，不会变成 Org B 明文。
- 证据：`pnpm --filter @lody/e2ee-lab check` 退出 0（10 文件 / 38 测试）。Wasm 物理时钟、Fiber/`exclusive` 中断、OS 隔离仍未注入。未启用产品 E2EE。无 push/PR/merge。

### 2026-09-17 — 拦截 replace 与截断 CAS ACK

- `replace` 成 HTTP 502 时客户端为 `unknown`；resume（手动模式第二次许可）提交成功，不会出现本地假成功。`truncate` 先打真实 CAS 再只回 1 字节；客户端仍能靠读回看到提交（`committed`，或 `unknown` 再 resume）。不用空 200 响应（会让 streams 客户端挂起）。
- 证据：`pnpm --filter @lody/e2ee-lab check` 退出 0（10 文件 / 40 测试）。Wasm 物理时钟、Fiber/`exclusive` 中断、OS 隔离仍未注入。未启用产品 E2EE。无 push/PR/merge。

### 2026-09-17 — 审查 P1：取消勾选；修验签、错误、裁判、重放、矩阵、内容门控

- 对 `58a3f698` 的审查不是验收。已取消 C1、C2、P1–P5。P4 仍是脚本探索，不是 Agent。
- `Ledger.verify` 只接受工厂授信的 executor（`createSequentialSignatureVerify` / Node 适配器）。`{verify: async jobs => jobs.map(() => true)}` 为 `invalid-operation`；伪造签名仍失败。
- 无 pending 时 `resume()` 抛 `LedgerError`（`invalid-operation`），不是 FiberFailure。内层 `exclusive` 使用 `runPromiseThrow`。
- Content 测试的 `getRandomValues` 经 `Uint8Array` 视图写入。
- AttackLab `finish` 不再把 `forged-accepted` / `cursor-overrun` 声明当违规；宿主已关为 `unavailable`。公开动作日志脱敏声明证据；`harnessReplayActions` 供重放保留。
- 重放比较 `responseHex`。恶意服务器 append 使用 Riverrun 当前 tail；若没写入，矩阵为 `harness-error`。
- 门控覆盖会改写的 `/ds/`（内容 POST），不只 `/append-cas`。会话保留 Loro 副本，不再写完即 free。
- P4 Agent 仍不勾选。

### 2026-09-17 — 实测裁判、落盘阶段门控、harness 重放；P4 仍阻断

- `finish()` 的完整性/耐久用 `inspectHonest`（真实 `readLedger` 长度）或 Riverrun 控制流计数/offset 相对基线。不用未认证的宿主 GET。后端测不到则为 `harness-error`，不是 pass。`forged-accepted` / `cursor-overrun` 声明不再强制 `violation`。sqlite xor 后宿主关闭为 `unavailable`。
- 正式重放使用 `harnessReplayActions`（保留声明证据）。公开 `actions()` 仍脱敏。只重放公开日志里的明文声明得到 `pass`，不作为正式判定。
- 手动模式记录 `document-persisted`、`cursor-persisted`、`import` 并等待许可。写路径保留 Loro 副本。
- P4 Agent：`runRestrictedAgent` 经 OpenRouter `openai/gpt-4o-mini` 选择 `observe` / `readBackend` / `finish`（不是 `exploreAttackLab` 定点 xor）。harness 重放判定同为 `pass`。额度/密钥错误会失败。隔离仍隐藏秘密。
- 证据：lab check 10 文件 / 46 测试；core 排除 10k 为 34/384；`tsgo --noEmit` 两次退出 0。未启用产品 E2EE。无 push。

### 2026-09-17 — 三个阻断项关闭：客户端观测裁判、四点崩溃矩阵、私有材料精确重放

- 起始工作树：`ecaa1f12` 上三个失败 —— `attacks.test.ts` 裁判把后端增长当失守、`runtime-permit.test.ts` 手动许可死锁、`restricted-agent.test.ts` 重放 `harness-error`。
- 阻断 A（裁判）：`judgeImport` 只依据诚实导入行为；后端记录增长仅作诊断。`defectiveAcceptInvalid` 表达"缺陷导入器接受非法记录"→ violation；客户端拒绝非法记录 → pass；仅后端增长 → 不报 violation。端到端：`finish()` 完整性/耐久输入只来自 `inspectHonest` 的客户端观测，缺观测为 `harness-error`。
- 阻断 B（持久化）：`test/crash-loro-client.ts` 子进程 + `host-lifecycle.test.ts` 四点矩阵，`process.kill(pid,'SIGKILL')` 在 `after-import`/`after-document`/`before-cursor`/`after-cursor` 真实杀死进程；同目录同设备重启后文档与游标一致。修正 `after-import` 语义：streams-crdt 的 `appendWriteOnly` 不落 remote cursor，崩溃点设在 `beforeRemoteCursorSave` 钩内、文档持久化之前；重启从后端重新导入未落盘更新，游标不超前一跳数据。
- 阻断 C（精确重放）：回放恢复相同设备私钥（`exportDevice`）与 `replayEntropy(recorded.fills)`，genesis/密文逐字节一致，`mutateBackend` 的 needle 命中真实密文切片而非 sqlite 文件头。公开动作无私钥/明文；回放不调模型；回执、协议字节或客户端状态不同报首个分歧字段。
- 调度死锁根因与修法：streams-crdt 在已许可的 `import` 阶段内调 `remoteCursorStore.save`，嵌套 `cursor-persisted` gate 永远拿不到许可。不放宽单许可不变量，用 `AsyncLocalStorage` 让嵌套 `phase()`/`gatedFetch()` 继承父事件许可并以 `owned` 标记只让所有者 complete；AttackLab advance 循环在事件 permitted 期间不再请求新许可。
- 证据：lab `vitest run` 11 文件 / 56 测试退出 0。

### 2026-09-17 — Effect 中断贯通与缓存隔离（E1）

- `submit`/`delivery` 保持单一 Effect 实现，Promise 只是入口包装。`runPromiseThrow(effect, signal)` 把 `runPromiseExit` 的中断 signal 传入 `store.exclusive` 回调内的内部 runtime；`tryCall` 改为接收 Effect 提供的 signal。
- `delivery` 对远端 `put`/`read` 用 `abortable` 包装：远端调用本身不可取消，但本地等待可中断并释放 outbox 锁；pending 精确字节先落盘，重试只读回确认，不重复加密。新增用例：CAS 中途中断保留 pending、resume 提交同一字节；put 中途中断保留 outbox 帧并释放锁。
- 缓存隔离：`SigningPointCache` 参数贯通全部验签路径 —— `Ledger.verify`/`extend`/`verifySnapshot`/`prepare`/`finalize`/`prepareSnapshot`/`finalizeSnapshot`/`comparisonNote`/`compareNotes`，以及 schema/snapshot/policy/keys/submit-decision 的解码与校验函数；`LedgerClient` 构造与 `open`/`openFromSnapshot`/`openJournal` 接受 `pointCache`。实验室 `DemoSession` 与 `startDemoHost` 各持实例级缓存，实验间不共享可变缓存。`capabilities-boundary.test.ts` 新用例证明 `extend` 同步路径消费注入缓存且禁用缓存不改变结论与错误语义。
- 剩余限制：Wasm 物理时钟仍属库内部；legacy 控制日志（`wire.ts`）与未传 `pointCache` 的默认调用仍共享 `liveSigningPointCache`（纯记忆化，不改变验签结论）；Promise 入口本身不接受 AbortSignal。未启用产品 E2EE。无 push/merge。
- 证据：`pnpm --filter @lody/e2ee-core exec vitest run` 35 文件 / 389 测试退出 0；lab 11 文件 / 56 测试退出 0；两包 `tsgo --noEmit` 退出 0。

### 2026-09-17 — Runtime 等待者清理与格式收尾

- `LabRuntime` 新增 `close()`/`closeAll()`：手动模式遗留的 `gate`/`whenRequested` 等待者被 `runtime-closed` 拒绝，不再永远挂起；`gate` 在关闭后直接抛错。`cleanupLab` 先 `closeAll` 再关客户端与宿主。
- `runtime-permit.test.ts` 新增用例验证挂起 gate 与 whenRequested 均在 close 时拒绝。
- 证据：lab `vitest run` 11 文件 / 57 测试退出 0；`tsgo --noEmit` 两包退出 0；`pnpm lint:fast` 0 错误；lab prettier 检查通过。`pnpm check` 中 core/lab 全绿，但 `apps/cli` 的 `worktree-gc.test.ts` 因 `/var` 与 `/private/var` 路径规范化差异失败（与本任务无关的既有问题）。未启用产品 E2EE。无 push/merge。

### 2026-09-17 — 复审 P1 修复：观测缺失不得通过、显式子事件调度、重放接入完整差异核验

- 裁判：`HonestInspect` 改为纯测量事实（`verifiedRecords`/`rejectedRecords`/`unverifiedAccepted`/`cursorAhead`/`durableLoss`）。`inspectClient(client, host)` 是默认采集工厂：真实 `readLedger` 计数、后端 `riverrunRecordCount` 对比得出拒绝数、打开客户端 `ledger.sqlite` journal 用 `Ledger.verify` 重验每条持久记录（验不过即客户端接受了未授权状态）、游标/文档文件一致性与 Riverrun tail 对比得出游标超前与持久数据丢失。`finish()` 只在这些事实齐备时判 pass；回调抛异常、`unmeasured: true`、或只回账本长度均为 `harness-error`。`lostDurableData` 不再写死 false。
- 调度：撤销"嵌套阶段继承父许可"。`LabEvent.parent` 记录父子关系，嵌套 `phase`/`gatedFetch`/`deliver` 成为需要独立许可的子事件；不变量改为"permitted 集合必须落在一条祖先链上"（`canPermitEvent` 只允许目标事件的祖先处于 permitted）。`/ds/` 的 GET/HEAD 读也进入门控（`read` 操作），响应返回前另有 `deliver` 关卡；攻击者可在任意阶段边界介入。`permitUntil`/`drainRuntime`/`drainUntil` 辅助只放行可许可且未暂停的事件，不再忙等 `permit-busy`。
- 重放：`replayAttackActions` 返回 `{report, divergence}` 并真正接入核验 —— 期望事件（含 `time` 与 `parent`）、协议帧、`ClientDigest`（ledger 记录数 + genesis+records 的 sha256 + 规范化游标，剔除每次运行不同的端口与墙钟）、逐项 verdict、以及此前已有的密文修改回执，任一不一致报首个分歧字段。`harnessReplayMaterial(lab)` 异步导出完整私有材料；公开 `actions()` 仍脱敏。restricted-agent 验收改为断言 `divergence === null`。
- 反例实测：观测抛异常/unmeasured/部分观测 → `harness-error`；manual 未授权 GET 阻塞且产生 `read` 事件；只放行 `import` 时 `cursor-persisted` 作为子事件独立排队；改事件 `time` 报 `time`、改帧响应报 `frame.response`、改客户端摘要报 `client.ledgerHead`、改 verdict 报 `verdict.confidentiality`。
- 证据：lab `vitest run` 11 文件 / 61 测试退出 0；`tsgo --noEmit` 退出 0；`pnpm lint:fast` 0 错误；`pnpm format` 通过。未启用产品 E2EE。无 push/merge。

### 2026-09-17 — 复审第二轮：游标与持久化文档绑定、失败结果同样经过 deliver 关卡

- 游标绑定：`cursorFacts` 不再只检查文档存在与 `nextOffset ≤ tail`，新增 `docCoversCursor` —— 加载持久化文档，要求文档版本覆盖 cursor 的 `serverLowerBoundVersion`（Loro 用 `oplogVersion().compare()` 需返回 ≥0，注意 `VersionVector` 的 Map 键必须是字符串形式 PeerID；Flock 用 `inclusiveVersion()` 逐 peer 比较 `physicalTime`/`logicalCounter`）。文档回滚为有效旧 snapshot 而保留新 cursor → 版本覆盖失败 → `ahead=true` → durability `violation`；无法判定时 `ahead=undefined` → `harness-error` 而非 pass。`ClientDigest` 增加 `loroDoc`/`flockDoc` 持久字节 sha256，同一回滚在重放中产生 `client.loroDoc` 分歧。
- 失败交付：`gatedFetch` 重构为"执行 → 记录帧 → complete(request) → deliver 关卡 → 返回/抛出"。`intercept-drop`、网络异常与成功响应一样先形成待交付结果，`deliver` 事件未获许可前调用方拿不到错误；攻击者可以控制失败结果的交付时机。
- 反例实测：v1 文档 + v2 游标 → `durability=violation`（此前 pass）；manual 模式只放行 `request-queued` + drop 拦截 → 读调用保持未决、`deliver` 事件 `requested`，放行后才以 `stream-read-unknown` 送达。
- 证据：lab `vitest run` 11 文件 / 63 测试退出 0；`tsgo --noEmit` 退出 0；`pnpm lint:fast` 0 错误；`git diff --check` 干净。未启用产品 E2EE。无 push/merge。

### 2026-09-17 — 复审第三轮：Flock 覆盖检查修复与类型修正

- `Flock` 没有 `free()`，`finally` 中的 TypeError 被外层 catch 吞掉使 `docCoversCursor` 恒为 `undefined`；删除该调用后 Flock 回滚（旧 `flock.doc.bin` + 新 cursor）正确判 `durability=violation`，新增回归用例 `flags a Flock document rolled back behind its persisted cursor`。
- `VersionVector` 构造的 Map 键类型修正为 `${number}`（loro-crdt PeerID 的实际接受类型），`pnpm --filter @lody/e2ee-lab typecheck` 退出 0。
- 证据：lab `vitest run` 11 文件 / 64 测试退出 0；`pnpm lint:fast` 0 错误；`git diff --check` 干净。未启用产品 E2EE。无 push/merge。

### 2026-09-18 — S1–S4 协作验收：持续协作脚本、边界介入、真实模型、三目录重放

- 场景：`src/scenario.ts` 新增 `collabScript()` 42 步固定脚本（Alice 建空间→Bob 加入分钥→双方 Loro/Flock 持续编辑→Bob 离线编辑重连→Carol 中途加入读历史→撤权 spare 设备+epoch 换代（旧历史仍可读、被撤权设备拿不到新代密钥）→快照上传→Dave 快照 bootstrap 继续同步→子进程 SIGKILL 崩溃恢复→宿主重启全量收敛）。`runCollabScenario` 每步把首个 `request-queued` 边界暴露给攻击者后才放行；`replayCollabScenario` 用相同私有材料（设备导出、seededEntropy fills、密钥帧、明文期望）在全新目录无模型重放。
- 确定性：Flock `put` 的物理时间戳经 `ContentClient.now` 注入世界逻辑时钟（否则两次运行密文不同、帧比较必分歧）；Riverrun multipart 响应的随机 boundary token 在帧比较中规范化；`readKeyFrames` 返回页体（裸帧串联、无长度前缀），用最小 CBOR 步进器切出最后一帧作分钥材料。
- S1 对照全脚本收敛、判定全 pass；S2 固定 drop 命中 bob 的 pending 响应（帧 `responseStatus=0` 命中证据）；S3 同一记录三目录重放 `divergence === null`，篡改事件 time/帧/客户端摘要/verdict 各报首个分歧字段。
- S4 真实模型：`collabModelAgent` 一次性规划——模型只在第一轮被咨询一次（看到 `remainingSteps` 后选一个介入步骤+一个攻击），agent 在该步触发并从此 pass。实测 openrouter `gpt-4o-mini` 选 `intercept`@step 2（alice-approve-bob），帧 `responseStatus=0` 命中，同一记录在三个新目录无模型重放均 `divergence === null`；拦截打断 bob 加入流使该客户端观测缺失 → `integrity/durability=harness-error`（缺观测不判 pass，符合契约）。模型 fetch 加 `AbortSignal.timeout(60_000)`；`createAttackLab` 增加 harness 侧 `maxMs`（协作全程+模型延迟超出 30s 默认预算；攻击者不可改）。
- 新发现死锁：记录的 `finish` 动作在重放中经 `applyRecorded` 裸调 `lab.finish()`，其 `measureHonest` 发 gated `readLedger` 无人放行 → 死锁。修法：`applyRecorded` 三处调用点统一包 `drainUntil`，与 live `lab.finish()` 语义一致。
- 证据：lab `vitest run` 14 文件 / 71 测试退出 0（含真实模型 S4）；`tsgo --noEmit` 退出 0；`pnpm lint:fast` 0 错误；`pnpm format` 干净。命令固化：`scenario:collab` / `attack:model` / `replay`。未启用产品 E2EE。无 push/merge。
- 剩余限制：S4 判定为 harness-error 而非 pass——这是被攻击打断后的诚实观测结论，不是测量缺陷；模型服务端不可用属外部阻塞（本环境 OpenRouter/Groq/DeepSeek/OpenAI 密钥至少一个可用时 S4 才能跑）。

### 2026-09-18 — AttackLab Effect 服务纯化（E3 子集）

- 新增 `src/services/`：`LabClock` / `LabFs` / `LabHttp`（`Context.Tag` + `Layer`），`LiveLabLayer` 为 Promise 默认适配；测试可用 `makeTestClock` / `MemoryLabFs` / `TestLabHttp`。
- `attacks.ts` I/O 改为 `*Effect` + Live 薄包装；`attack-lab.ts` 全部公开方法经 `runLabPromise(..., layer)`；预算/读盘/xor/healthz 不再直接碰 `Date.now`/`node:fs`/`globalThis.fetch`。
- `LabRuntime` 构造注入 `fetch`（默认 `globalThis.fetch`），`gatedFetch` 不再硬编码全局。
- **未做**：host/session/persist/content-session/scenario spawn、restricted-agent LLM fetch、HPKE/Wasm 随机闭合。Effect 仍非沙箱。
- 证据：`test/services.test.ts`（预算时钟、内存 Fs、inject fetch、内存 xor）；`pnpm --filter @lody/e2ee-lab check` 退出 0（13 文件 / 73 测试，含真实模型 S4）。未启用产品 E2EE。无 push/merge。

### 2026-09-18 — 第二轮：host/session/persist/content/LLM 端口注入

- `LabFs` 增加 `mkdir` / `writeText`；`persist`、`FileRemoteCursorStore`、`DemoSession`、`startDemoHost`、`content-session`（含 crash marker 与 `updatedAtMs`）均接受可选 `fs`/`now`/`fetch`，默认 Live 适配器。
- `restricted-agent` 的 LLM `fetch` 改为可注入 `LabFetch`；`scenario` 的 secret/seed 走 recording entropy，marker 读经 `LabFs`。
- **仍直接用 Node**：crash 子进程 `spawn`、`cli.ts`、fixtures 的 `mkdtemp`/`rmSync`（进程生命周期边界，非 AttackLab 主路径）。
- 证据：`pnpm --filter @lody/e2ee-lab check` 退出 0（13 文件 / 73 测试）。未启用产品 E2EE。无 push/merge。

### 2026-09-18 — 有效裁判、加深 Agent、设计探查

- **裁判：** `composeIntegrity` / `composeDurability` / `judgeClaim` / `judgeUnauthorizedContent` 把测量事实与 claim 接上。恶意 Riverrun 下 guest 作者内容记为 `outside-model`，不再静默 pass。
- **修复：** host `loadLedger` 不再粘性缓存；`adoptGenesis` 绑定 `hash(genesis)`；honest `mayWriteDocument` 同时约束 update seal。
- **模型限制（不改 trust）：** open 仍接受恶意主机 + 持有 epoch key 的 guest/revoked 设备密文；矩阵与 design-probes 记为 outside-model。
- **Agent：** 多步 mutate/intercept；collab 可带 followUp；无命中证据的 claim 不算成功。
- 证据：lab check 14 文件 / 78 测试退出 0。未启用产品 E2EE。

### 2026-09-18 — 新探针：分钥发送者、宿主成员 ACL、旧代密封

- **新发现（矩阵原先未覆盖）：**
  1. `openEpochEnvelope` 验了接收者、代次、HPKE 和密钥承诺，但没有 `canSendEpoch`。已持有当前代密钥的成员（或被降级的 Admin）可在本地伪造 admin 状态封出真实信封，诚实接收端用真实账本仍会打开。白皮书：只有 Owner/Admin 分发当前钥；入账不等于密钥可用。
  2. 诚实 lab host 的 `/ds/` GET/HEAD 把 `credential.genesisHex == null` 当成无约束，并接受客户端自报的 `genesisHex` 发凭证。任意已登录设备可读其他 Org 的控制/密钥/内容流和申请列表。A5 云端 ACL：会话须核对当前账本资格。
  3. 内容密封用 `max(本地代次密钥)`，不是已认证账本代次。`publishEpoch` 后滞后的诚实成员仍用 epoch-0 写新密文，被撤且仍持 `K0` 的设备一旦拿到字节就能读“换代后的新内容”。白皮书：只有新代内容对被撤者保密。
- **修复：** `openEpochEnvelope` 打开前检查 `canSendEpoch`。Host `/ds/` 与 joins/notes 读取要求设备在该 Org 账本上。诚实 `writeLoro`/`writeFlock`/快照密封走 `prepareWrite`，缺当前代密钥则 `missing-current-epoch-key`。被撤设备可保留本地明文，云端再读为 403。
- **未改的模型限制：** 恶意 Riverrun 下 guest/已撤设备密文仍是 `outside-model`（`open` 不复查当前写权）。
- 证据：`test/ledger-keys.test.ts` 未授权发送者信封；`test/design-probes.test.ts` 外人读取、成员伪造信封、旧代写入。`pnpm --filter @lody/e2ee-lab check` 退出 0（14 文件 / 81 测试，含真实模型 S4）。核心 keys+delivery+krc-loop 28 项退出 0。未启用产品 E2EE。无 push/merge。

### 2026-09-18 — sqlite Riverrun 前的薄宿主网关

- **决定：** 云端 ACL 不进 Riverrun sqlite。诚实宿主是薄网关：现读已验证账本，使用 `deviceMayWriteDocument` 和导出的 `canSendEpoch`。设备不是当前成员则不签发声称 genesis 的令牌。创世 GET 需要登录。加入 POST 把请求公钥绑到凭证设备。快照写权用请求范围的 `AsyncLocalStorage`，不用全局 genesis。直连 `riverrunUrl` 仍无鉴权。记在[宿主网关笔记](../../implemented/architecture/2026-09-18-e2ee-host-gateway.zh.md)。
- **未改：** 生产 JWT/网关未实现；恶意 Riverrun 下 guest 内容仍是 `outside-model`。
- 证据：`test/gateway.test.ts`；`test/design-probes.test.ts` 外人读取 vs 裸 Riverrun、声称 genesis 签发 403、guest 读写分流。`pnpm --filter @lody/e2ee-lab check` 类型检查加沙箱内 14 文件 / 88 测试；联网后 `test/restricted-agent.test.ts` 2/2（15 文件 / 90 测试）。核心 `test/ledger-keys.test.ts` 6/6。`pnpm run docs check` errors `[]`。未启用产品 E2EE。无 push/merge。

### 2026-09-21 — 设计探针：宿主旁路、guest 准入窗口、裁判缺口

- **不是修复。** `test/design-probes.test.ts`（`newly observed defects`）目前断言缺陷现状，避免静默消失，不是目标契约。Spec 未改。未启用产品 E2EE。
- **已测到：**
  1. 诚实宿主 `/readyz` 无需登录，返回 `riverrun` 和数据库路径。只用宿主 HTTP 的调用者即可直连 sqlite Riverrun 读 Org 密文，把 Spec §4 的外部攻击者与恶意服务器两种模式叠在一起。Lab CLI 也会打印 `riverrunUrl`，并以 `testMode: true` 启动。未鉴权的 `/v1/failpoints` 以及任意 testMode 请求（含 `/healthz`）上的 `x-e2ee-demo-now` 会改进程级宿主时钟，并可让现有凭证过期。
  2. 未登录的创世 GET 是存在性预言：未知空间 `404`，已有空间 `401`。
  3. `admitMember` 一律写入 `role=member`。guest/admin 要再发 `setRole`。准入并完成分钥后、`setRole→guest` 前，加入者可以 `writeLoro`，诚实成员会导入。`approveJoin(..., 'guest'|'admin')` 返回的是 admitMember 状态，第二次 submit 失败会被忽略。
  4. 账本 `JoinRequest.expiresAt` 已签名，但 `applyOperation` / 宿主 `control-cas` 都不做准入预检（纯校验不含时钟是对的）。`expiresAt: 1` 的加入仍会提交。旧 `join-request.ts` 在准入时检查 `now < expiresAt`。
  5. `approveJoin(..., 'admin')` 把角色写成 admin，但加入设备仍是 `canManage=false`，因此 `canSendEpoch` 为假。角色与每设备 `canManage` 的交集是协议原意（`ledger-matrix` 的 `admin-join-*` 为 unauthorized）；这是 lab 助手的陷阱，不是策略绕过。
  6. 裁判 `inspectClient` 把任何能打开、且当前账本设备没有 `deviceMayWriteDocument` 的 Loro 帧标为未授权。诚实成员写完再 `setRole→guest` 后，`finish().integrity` 变成 `outside-model`（误报）。
  7. 同一扫描只读 `LORO_STREAM`。经 `riverrunUrl` 注入的 guest Flock 会被诚实 `readFlock` 导入，但 `unauthorizedContentAccepted` 仍为 false（相对 Loro 行是漏报）。
  8. 宿主 `content-cas` 只查成员写权，不查密文代次。换代后仍在组织内的成员若跳过 `prepareWrite`、用 epoch 0 密封，字节能落地且诚实成员会打开。诚实客户端仍拒绝；这是宿主对串通在籍成员的缺口（明文外泄本就不在服务器保密范围内）。被撤读者仍需能拿到密文（恶意 Riverrun 或串通）。
- **未改的已记录限制：** 快照准入在异步验签期间仍可能用 `AsyncLocalStorage` 里的旧账本（15 分钟残余窗口）；`open` 不复查当前写权；隔离只靠 AttackLab 能力句柄。
- 证据：`pnpm --filter @lody/e2ee-lab exec vitest run test/design-probes.test.ts -t 'newly observed'` 退出 0（7 通过）。无 push/merge。

### 2026-09-21 — 独立复现包、失败指纹、最小反例

- **本轮目标：** 已捕获失败生成可在新进程/新目录重放的包，再缩成最小反例。未 reset 已有网关/裁判/探针改动。
- **调度：** `LabRuntime.permitLog` 记录每次许可。自动推进规则是最早可运行事件（`permitNext`）。身份 `ScheduleDriver` 用于显式并发选择（Bob 先于 Alice）。streams-crdt import/read 的嵌套请求顺序**不是**可控 microtask 边界；按身份强行重放协作时，记录还要额外 nested read，现场却卡在 `deliver`/`cursor-persisted`，会死锁。协作重放因此走 FIFO 规则；包里仍保存许可日志。
- **复现包：** `e2ee-lab-repro/v1`，`private/` 权限 0700。脏树单独哈希，不能只记 HEAD。CLI `tsx src/repro-cli.ts replay <packDir>` 只打印指纹和分歧。缺私有材料或不支持的格式失败闭合。随机记录必须 `remaining()` 为空，禁止回退 live 随机。
- **比较：** multipart 只改分隔符位置的 `--boundary`。载荷里像 `rr-bootstrap-*` 的文本保留。非法正文原样比较。失败指纹含规则 ID（`integrity.unverified-accepted`、`durability.lost-document`、`integrity.wrong-context`）。
- **裁判：** `packages/e2ee-lab/src/reference-model.ts` 不导入 `deviceMayWriteDocument` / `canSendEpoch`。已知缺陷改真实客户端状态（xor journal、有 cursor 无文档、外 Org journal），再由 `inspectClient` 观测。同一输入的正常对照为 pass。
- **缩减：** 有界 ddmin；缩成 harness-error 会被拒绝。`test/repro-pack.test.ts` 中 skip-verify 20/20 指纹相同。
- **后端限制：** 保留 SIGKILL 崩溃矩阵。未刷盘 SQLite 页的断电、FS/OS 内部故障、以及传输检查点重放均未覆盖。
- **Agent：** 破坏性命中只计 intercept 或 mutateBackend。本轮 `test/restricted-agent.test.ts` 2/2（模型密钥可用）。
- 证据：`pnpm --filter @lody/e2ee-lab check` 18 文件 / 116 测试，含 `test/repro-pack.test.ts` 8/8（20 次 skip-verify + 子进程重放）、协作 S1–S3、真实模型介入。未启用产品 E2EE。无 push/merge。

### 2026-09-21 — design-probe 定向修复（1–6、8）

- 基线：HEAD `c98f6804`。`newly observed` 7/7 仍在断言缺陷。Guest 探针在 admitMember 与 setRole 之间分钥，证明的是中间状态可写，不是 helper 必然在该窗口分钥。后端能解密 ≠ 客户端已导入。隐藏 Riverrun URL 不是网络隔离。
- **D1：** `/readyz` 只返回 `{ok:true}`。`x-e2ee-demo-now` 不再改宿主时钟。failpoint/时钟走 `host.setNow`/`setFailpoint` 或带 `harness.token` 的 `POST /v1/harness/*`。CLI 默认非 testMode，`--test` 才开 harness。恶意服务器测试仍用 `host.riverrunUrl`。隔离仍是能力句柄。
- **D2 helper：** `approveJoin` 返回 `admitted` / `roleConfigured` / `deviceCanManage:false`，非 member 角色时 status 是 **setRole** 的结果。丢 ACK 的 setRole 仍可 resume。这**不能**消灭 `admitMember` 的临时 member 写权窗口。
- **D3：** 宿主 control-cas 在 extend+CAS 前用宿主时钟检查非空 `expiresAt`。记录已是 `head` 则允许重试（丢 ACK）。纯 `Ledger.verify` 仍无时钟。剩余间隙：检查到 Riverrun CAS 之间时钟可能越过截止（无跨流事务）。
- **D4/D5：** 裁判用持久化 Loro/Flock 加实验室写事实和 `refMayWriteDocument`（不用 `deviceMayWriteDocument`）。降级作者的历史仍合法。Guest Flock 导入会标记。仅后端密文不算接纳。无法归属则为 `contentScanIncomplete` → harness-error，不是 pass。
- **D6：** 未登录访问 `/v1/spaces/...` 和 `/ds/...` 先鉴权再查存在性（401/401）。
- **D8：** 加入设备保持 `canManage=false`。无管理能力的 Admin 不能 `canSendEpoch`。该 Admin 显式 `admitDevice(..., true)` 可以。机器不能 `canManage`。
- **待决策 D2 协议 / D7 代次：** 见下。未改 wire。旧代上传探针仍作特征化保留。
- 证据：`pnpm --filter @lody/e2ee-lab check` 18 文件 / 120 测试。未启用产品 E2EE。无 push/merge。

### 待决策 — 原子 Guest 准入

建议新的 ordinary op（或给 `admitMember` 增加角色字节），使一条签名记录直接写入 `role=guest`（或 admin/member），前面没有 member 状态。

- **编码：** 现 `admitMember` 为 `[1, membershipId, request]`，固定 `role=member`。在数组末尾加角色会让旧解码失败。更稳妥是新 op 码，而不是悄悄加长数组。创世 `protocolVersion=1` 不变；普通记录没有版本字段。
- **谁可准入何种角色：** 沿用现权限。Owner 或 Admin 的 personal+`canManage` 可准入 `member`/`guest`。仅 Owner personal+`canManage` 可准入 `admin`（与现 `setRole` 仅 Owner 一致）。加入设备仍 `canManage=false`。
- **兼容：** 旧客户端不能产生或校验新 op。在切断前实验室/核心测试需双跑旧 `admitMember`+`setRole`。
- **无临时写权的证明：** 该单条记录之后，加入设备 `refMayWriteDocument` 为假，`writeLoro` 抛错，控制流上不存在该设备为 `member` 的前缀。延后分钥**不是**这条证明。
- 确认前不实现。

### 待决策 — 旧代内容上传

当前诚实网关 `content-cas` 只查成员写权，不查密文代次。诚实 `writeLoro` 用已认证账本代次密封。换代后仍在籍的成员若跳过 `prepareWrite`，仍可用 epoch 0 上传，诚实对端会打开。宿主无法把这与“换代前已密封、现在才上传”的离线设备区分开。

线上可信证据是内容头里的 epoch（未验证路由元数据）加上当前成员资格。客户端自报创建时间不是证据。可选：（A）保可用性，只靠诚实客户端 `prepareWrite` 拒绝；（B）网关拒绝头 epoch ≠ `currentEpoch`，离线换代前密文会失败；（C）与最后所见代次绑定的租约，仍要可信时钟，也不能阻止串通在籍成员用别的方式泄密。

建议维持（A），请用户确认：诚实网关是否必须接受头 epoch 落后于 `currentEpoch` 的密文，以便离线换代前上传仍然可用？

### 2026-09-21 — helper 补强：部分准入、过期识别、裁判覆盖

- 基线：HEAD `04b90b58`。D1–D6/D8 已落地；剩余 helper 缺口：`approveJoin` 在 `setRole` 失败时抛错（丢掉 `membershipId`）、每次生成新身份、宿主过期只把当前 head 当成丢 ACK 原提交。
- **D2 helper：** 先 resume pending；按签名钥复用已有 membership；捕获 `setRole`/`admitMember` 失败并返回 `{admitted, roleConfigured, status, membershipId}`，不报虚假 Guest/Admin 完成。重试不新建成员。不是原子 Guest 准入。
- **D3：** `hasRecordHash` 识别已验证账本中任意位置的过期前已提交记录，不只是 head。检查仍紧挨 extend+CAS；Riverrun await 仍是异步间隙。
- **D4/D5 补测：** Guest Loro 导入（已有）、Flock 导入、仅后端存在、降级、快照作者被撤权、解码/归属不完整 → `contentScanIncomplete`。
- **D1：** 带 token 的 `/v1/harness/clock` 仍能改时间；普通 `host.json` 在非 `testMode` 下不含 Riverrun 路径。
- 证据：`pnpm --filter @lody/e2ee-lab check` 18 文件 / 125 测试。翻转签名改为结构化拒绝。未启用产品 E2EE。不 push/merge。

### 2026-09-21 — 第二份 review 增量（compareNotes、independent、换代候选）

- 基线：HEAD `02b3f473`，脏树仅无关未跟踪文件。未重做 D1–D8。
- **S1：** 同 genesis+head 但 length/digest 不同不再是 pending-sync。同 length 不同 head 为 conflict。不同 head 且不同 length 仍 pending-sync。真实签名快照：真 head、假状态、length+1，双方再追加同一记录仍 conflict。journal 重开不降级。不从 HTTP offset 反算 length。
- **S2：** `independent` 需要调用方提供外带 `confirmedNoteSigners`。不同公钥、背书者第二台设备或快照成员列表不够。实验室 `compareIndependent` 把额外信道当作对 `remote.noteSigner` 的确认；服务器邮箱笔记不算。核对成功不是全球最新或全历史诚实。
- **S3：** `publishEpoch` 在 `LedgerClient.submit` 之前写入 `{genesis, epoch, commitment, secret, record}`。存储失败不发 CAS。丢 ACK/重启恢复原记录，仅当账本 commitment 匹配才安装候选。冲突丢弃候选。不是跨系统事务。
- **S4：** 已复现：Bob 可提交 Alice 设备证明并把设备绑到自己；Alice 再提交是 `replay`。v1 证明仍不绑 membershipId。方案见下；未改 wire。
- **S5：** `checkEpoch` 拒绝会在 uint32 AAD 截断的值；快照宣称 length 超过 `MAX_SNAPSHOT_ARRAY_LENGTH` 为 `oversize`，不按宣称 length 巨额分配；`verifySnapshot` 在 `importAuthState` 前验签。
- **S6：** 归类见下。本仓库无 `.lean` 源码；`ledger-model-correspondence` 的 TS trace 仍通过。未启用产品 E2EE。
- 证据：lab check 18 文件 / 128 测试；core 排除 10k 长链 34 文件 / 399 测试。`pnpm run docs check` errors `[]`。未启用产品 E2EE。不 push/merge。

### 待决策 — 持钥证明绑定目标成员

v1 `possessionSigningBytes` 为 `[genesis, signPub, encPub, kind, canManage]`。`admitDevice` 绑到提交者的 membership。任何看到证明的成员都能占用这对密钥。

建议新证明编码（不要悄悄加长 v1）：为已有成员加设备时绑定 `targetMembershipId`。首次 `admitMember` 仍用加入申请（当时还没有 membershipId）。保留 R 给该用户准入个人设备。`usedSigningKeys`/`usedEncKeys` 仍在 Org 内消费密钥；请求 id 还能阻止未使用证明被重放。旧 pending 仍是 v1。确认前不实现。

### 待决策 — 授予 canManage 是否要求 actor.canManage

当前 spec §8.3 与 `policy.ts` 允许 Owner/Admin 的 `canManage=false` 个人设备给新个人设备设 `canManage=true`。这不是传递性上限。已保留表征测试。若收紧：设置 canManage 需要 actor.canManage，R 恢复管理个人设备作为显式例外。确认前不实现。

### 已归类（不写成“已修复”）

- **恶意 Admin 历史包：** 已接受的可用性限制。任意 72 字节包可提交；`recoverHistory` 失败；不新增重发 opcode。
- **openJournal：** 再加载会用持久化 trust 调用 `verifySnapshot`。磁盘不是第二份 pin。能改写全部本地可信存储的攻击者超出 journal 威胁模型。
- **Convex 备份：** 私有产品，本轮不改。风险是最新 revision 污染/恢复可用性，不是已证明的永久删除。同一 identity 也可上传垃圾密文；pin backupId+revision+identity 是后续产品修复。
- **HKDF / 历史 AEAD：** 用 epoch key 做历史包 AEAD 有域分离 AAD 和 72 字节包。本身不标成漏洞。
- **X25519：** `checkEncryptionPublicKey` 只拒全零和长度错误。不套用 Ed25519 子群规则。低阶点/别名本轮不改套件。
- **legacy 导出：** `./legacy` 仍供包内测试，不删除。
- **Lean / 产品：** 本仓库无 Lean 文件（同角色 `setRole` 在 TS 为 `invalid-operation`；未重跑 Lean）。二维码/Passkey/JWT/机器仍范围外。有限 trace 不是全部对应关系证明。

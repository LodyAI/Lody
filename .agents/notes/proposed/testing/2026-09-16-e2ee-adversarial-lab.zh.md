# 用确定性攻防实验室替代 E2EE 教程

Status: proposed
Translation: current

[English](2026-09-16-e2ee-adversarial-lab.md)

## 摘要

可视化教程增加了交互开发，却没有提供足够可复现的安全证据。替代实现已落在 `packages/e2ee-lab`：确定性正常协作、一个仅能使用 AttackLab 能力句柄的攻击 Agent、真实本地 Riverrun，以及无 LLM 重放。本文在审查前仍为 proposed。这不是恶意服务器无法中断服务的证明，也未启用产品 E2EE。

## 决策与范围

[Spec](../../../../specs/e2ee-adversarial-lab.zh.md) 定义契约；本文是唯一实施任务表和追加日志。本方案部分替代[独立 demo 提案](../architecture/2026-09-16-e2ee-independent-demo.zh.md)：保留后端/公开 API 边界和有效回归，替换浏览器与游戏交付方式。正常端使用确定性程序，只有攻击端使用 Agent。全序调度是测试方法，不是新增协议保证。采用普通 TS 纯计算、显式能力接口和局部 Effect 流程，不重写密码学，不采用 Rust 主控。

## 实施计划与唯一任务表

当前状态：对 `58a3f698` 的审查发现 P1 阻断。正在修复 C1/C2/P1–P3；P4 Agent 与 P5 总目标仍不勾选。无 push/merge。实验室 Spec 仍为 draft。

| 完成 | 阶段           | 交付物                         | 必须通过的门槛                              |
| ---- | -------------- | ------------------------------ | ------------------------------------------- |
| [x]  | P0 基线        | 版本、备份、迁移清单、现状结果 | 用户未提交工作可恢复，回归覆盖有去向        |
| [ ]  | C1 显式依赖    | 纯计算边界、能力接口、兼容草图 | E1–E3，真实验签一致，随机/时钟来源完整      |
| [ ]  | C2 Effect 试点 | 唯一 submit/resume 实现        | E4–E7，CAS/丢 ACK/中断/重启正确             |
| [x]  | C3 其余流程    | 分钥、恢复、准入与资源管理     | E3–E6，权限重查与原始截止不回退             |
| [ ]  | P1 常驻协作    | lab 包、真实后端、三副本       | 离线重连与耐久恢复，不是一次性读写          |
| [ ]  | P2 确定性      | 调度器、记录、重放             | 三次新目录重放一致，首分歧可定位            |
| [ ]  | P3 固定攻击    | Spec 场景矩阵、有效裁判        | 真实改库被检验，注入已知缺陷时裁判失败      |
| [ ]  | P4 Agent       | 受限 API、自由攻击记录         | 隔离自测通过，至少一轮真实 Agent 运行可重放 |
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

- `finish()` 的完整性/耐久用 `inspectHonest`（真实 `readLedger` 长度）或控制流分帧计数。`forged-accepted` / `cursor-overrun` 声明不再强制 `violation`。sqlite xor 后宿主关闭为 `unavailable`；磁盘上没有期望明文则保密性不是 `violation`。
- 正式重放使用 `harnessReplayActions`（保留声明证据）。公开 `actions()` 仍脱敏。只重放公开日志里的明文声明得到 `pass`，不作为正式判定。
- 手动模式记录 `document-persisted`、`cursor-persisted`、`import` 并等待许可。写路径保留 Loro 副本。P4 Agent 仍不勾选：`XAI_API_KEY`/`GROK_API_KEY` 未设置；`OPENAI_API_KEY` 返回 429 `credit_balance_exhausted`。`runRestrictedAgent` 是非罐头循环，没有完成模型选步。`exploreAttackLab` 不是 Agent。
- 证据：lab check 10 文件 / 46 测试；core 排除 10k 为 34/384；`tsgo --noEmit` 两次退出 0。未启用产品 E2EE。无 push。

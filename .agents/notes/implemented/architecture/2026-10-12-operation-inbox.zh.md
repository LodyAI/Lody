# Operation 结果收件箱与反向 chat 限制

Status: implemented
Type: architecture
Translation: current

[English](2026-10-12-operation-inbox.md)

## 摘要

逐条结果续跑和反向创建 chat 会让对话反复恢复执行。现在可唤醒的回执通过队列合批恢复空闲且未暂停的会话；忙时等自然结束，Stop 后等新的用户消息。原生 Effect 内核负责持久调度与准入，Session／ACP 仍是明确登记的临时 adapter。当前 PR 候选已实现，独立复审、Spec 批准和真实模型／桌面验收仍未完成。

## 决定与理由

[会话编排 Spec](../../../../specs/session-orchestration.zh.md)维护行为，[编排 README](../../../../apps/cli/src/orchestration/README.md#completion-consumption)维护实现与事务契约。本文合并原调查、反向 chat 修复记录、设计和实施计划；早期版本保留在 Git 历史中。

- 可唤醒回执与空闲调度意图在完成事务内一起持久化，忙时等自然释放。认领时合并全部可处理队列成员，包括被动结果；批次认领后才固定成员。重开恢复未提交意图；重复事件和空队列不能再次启动。
- 支持 Inbox 的 Stop 先持久暂停，再取消执行。Stop 前排队的输入保留历史，但失去执行资格；新的用户消息携带结果资料，不携带已取消的旧指令。用户原文、配置和因果深度保持不变，Agent 任务不能解除暂停。
- Stop、可信用户接受和真实 transport 启动共用准入。未知提交不重发，包括携带 batch 的用户输入的 stale-ACP 恢复；只重试结算。Scope 关闭或等待者取消不代表资源真实释放。
- B 当前准确输入由 Agent A 发起时，不能向 A 发新 chat。单条、批量和旧入口在接受新工作前返回 `REVERSE_CHAT_FORBIDDEN`；后续独立输入替换此限制。这样不需要任务图或 task/note 新工具，但不保证消除更长的环或重复向外委派。

历史调查没有定位到“模型更频繁反向发信”的单一改动。[PR #1262](https://github.com/LodyAI/Lody/pull/1262)改变的是 Agent 作者展示，不是普通执行提示；没有证据支持通过回滚头像修复。已有放大路径是反向创建任务和逐 Delivery 续跑。源码核对不是受控模型重放。

2026-10-12 的调研借鉴了 [Codex 完成通知](https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/core/src/agent/control/completion.rs)与 [OpenCode 调度器](https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/session/run-coordinator.ts)的持久入队、独立准入和批量消费；没有照搬它们的 Stop 语义，也没有独立运行它们的测试。

## 所有权、恢复与兼容

Effect 保持锁定 4.0.2。`inbox/service.ts`拥有存储、信号和 scoped fiber；`operationInboxLegacy` 桥接 Session 输入；`operation-coordinator.ts` 与 `workspace-cleanup-legacy.ts` 是登记的应用入口，platform 资源观察器同步桥接创建前的登记回调。整个 Session／ACP／历史迁移尚未完成，边界见 [Effect 台账](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.zh.md#单元台账)。

`40ef5c29cbe496f28f17ab10297cf37c3c48030f` 的审核发现三个 adapter 缺口，修订落实以下契约：

1. 每次资源创建前持久登记“不完整”，持续合入后来的终端／进程 roots，保留全部 Session 所有者和发起 host PID。资源登记保留；[可用性决定](../bug-fix/2026-10-29-inbox-no-durable-block.zh.md) 取代释放证明准入，重启退役未知输入且不重放，释放失败移除旧 Agent，不阻塞后继。不能向可能被复用的 PID 发信号。
2. 可信 renderer／非委派 CLI 在激活或入队前持久保存 `humanInputReceipts`。RPC 丢失或输入过大时，历史兜底恢复匹配授权；普通历史、用户不符的回执、已取消／已结束输入不能解除暂停。
3. 协调器 `recoverStop()` 调用独立的 `recoverClose()`，只补写结算／释放／暂停回执。保留原失败回执和恢复所有者，不重发 transport，也不把再次关闭 Scope 当成恢复。

手动 Stop 的 RPC 与持久兜底共用请求 ID，防止迟到重复请求再次暂停新输入。写盘失败保留请求身份以便补写。已消费结果副本随 Operation 保留期清理；永久删除 Session 同时删除 Inbox 副本。最终存储边界是 schema／Inbox protocol v2、host launch v3。升级保留已经发布的 Operation 表、作者／输入快照、恢复状态和退役 ID，只删除旧 Delivery 表及未使用的兼容结果副本，旧通知积压不重放、不导入；当前 Inbox 的暂停、未知提交和资源所有权保留。完成结果直接入 Inbox，删除旧表、逐条认领／续跑接口、旧模型和旧协调器 fixture；结果序号持久递增，保留期清理不能重用旧水位。忙闲判断不再把被动结果算作执行。`inbox/legacy.ts` 只桥接仍未迁移的当前 Session／ACP，batch 成员的展示格式仍保留。Inbox 尚未发布，但 Operation 表已有发布版本，不能把二者的兼容性混为一谈。

作者来源与展示快照分开：保留下来的当前 Operation 即使没有作者快照，只要保存了 `sourceTurnId`，读取时也以冻结的 `requesterSessionId/sourceTurnId` 保留最小 Agent 来源，通用名称为 `Agent`，不补 Role、模型或目录信息。create/chat 在任何发布前拒绝缺少来源身份的委派；普通用户入口仍署名 human。反向检查直接读取准确输入的 Agent `sessionId`，不依赖父子关系。此修复保留已有 Operation，不重写既有历史。

Stop 请求详情改为 Session 控制文档内一个可覆盖的 `cancelRequest` 槽位，不再增加 metadata ID 字段。renderer 先持久保存详情，再写 `lastCanceledTurn = cancel-request:<id>`；RPC 保持立即发送，并使用同一 ID。Watcher 等待匹配的控制数据，通过独立取消链处理控制数据到达；旧版直接写 turn ID 的请求仍兼容。SQLite 负责持久去重，因此重开及迟到 RPC／兜底不会再次暂停新输入，新的点击仍有独立 ID。资源所有权、真实释放移交及暂停写盘失败恢复保持不变；本次 adapter 调整不扩展原生迁移。

与主分支 `09407b3b7` 合并后，保留原始 ACP 排空 → presence 清除 → turn／Inbox 移交的顺序。presence 清理失败仍保留旧执行所有者；daemon 关闭同时取消历史所属任务，并排空／恢复关闭 Inbox。依赖维持合并后的锁定版本，包括 Streams 0.17.0、Effect 4.0.2。能力注册同时保留 Inbox v2 和主分支新增的 Magpie／DSH 能力，不互相覆盖。

## 原生编排单元的落实

Coordinator 的协调、合并唤醒和重试已经迁到原生 Effect workflow；应用入口只负责组合与交接。纯规则与 platform 实现分离，边界检查禁止内核直接访问 SQL、Session、进程、Promise workflow 和运行时。SQLite Service 统一持有连接；Operation 与 Inbox 在同一连接中同步完成语义事务，事务回调禁止返回 Effect／Promise。内存 Layer 使用相同实现，仍属于副作用，不称为纯函数。Session 行无消费者的配置读写已删除，schema 不变。

ExecutionOwner 收拢输入、batch、资源和原始请求，负责提交、结算、真实释放与独立恢复；Session 不再直接访问 Inbox SQL。关闭所有者保留共享失败回执和完整 Cause，恢复只重试结算。Fleet 启动失败与正常停止共用阶段所有者，生产自动重试会先恢复旧所有者。Session／ACP／历史能力仍为登记的临时 adapter，不能据此声称依赖链全部迁移。

Agent 发起的 turn 结束后不发送用户完成通知。收尾读取本轮准确输入的作者（包括 steer 后的来源），不读取父子关系或旧输入；历史中的 Agent 输入不会影响后续用户 turn。Operation 回执、结果入队、收尾和资源释放保持原行为。作者读取后再检查 Stop。执行服务 256 项测试通过，包含 Agent 不通知、后续 human 正常通知及两者均完成历史／释放的边界。

升级审核指出三个发布边界：原迁移误删仍在运行的 Operation 和退役 ID、新客户端 Stop 向旧 CLI 发送不支持的字段、旧客户端 Stop 触发无法恢复的 Inbox 暂停。修订保留 Operation 与去重／作者／恢复记录，只移除旧 Delivery；界面与 CLI 按目标 Inbox v2 能力选择 Stop 格式；无协议身份的 legacy Stop 只取消当前执行，不持久暂停。选择这一兼容行为避免从缺失回执或 role／author 猜测 human 授权，升级客户端的持久暂停仍保持原契约。新用例运行真实 SQLite 升级与任务完成、React Stop 写入和 Session／Inbox 的 Stop 后新消息执行。

升级修订验证：CLI 4 suites／487 项、组件 79 项通过；三个定向用例在审核版本 `552c349` 分别失败，恢复修复后均通过。CLI Stop 另验证 released strict 解析拒绝新字段的边界及 Inbox v2 的显式暂停／Operation 取消行为。没有真实升级整机或旧桌面二进制端到端验收。

原生编排进一步简化：普通步骤直接 yield*，删除 Effect.exit→抛异常→恢复 Cause 的中间转换；只有 deadline、materialization 重试和进度降级边界处理失败，中断继续传播。删除只读 store 别名与恒定身份比较，保留实际运行／epoch 检查。Legacy 不再暴露 begin／prepare／submit／settle／adopt；提交回执进入 ExecutionOwner.submit，Session 不再手动结算 submitted。查询使用普通 Effect port 接口，删除无消费者的 Context.Service／Layer。没有合并或削弱共享关闭回执、真实释放、独立恢复和持久准入。

本次交集 4 suites／339 项通过，包含七个原生 Cause＋真实 SQLite 状态用例；覆盖组合失败、deadline 结算、进度降级与中断传播。共享关闭失败／独立恢复测试改为走生产执行 owner，仍验证原失败回执和不重发。此交集与前述结果重叠，不能累加；不扩大上游 Session／ACP／历史迁移完成声明。

合并 base `0b46cc2d8e33c6feafd08c00f51089456ab1e732`，不改写 PR 历史。冲突解决同时保留主分支可复用 Effect 函数转换及 lint 安装／检查脚本，以及 Inbox 准入与不重发、准确输入通知归属、sandbox 恢复 roots。解决后执行、sandbox、Coordinator 与 Inbox 六个 suite 共 391 项通过。全仓类型、lint（含 Effect lint）、format、quick 边界及文档检查通过；完整 CLI 测试 4137 通过、4 跳过，仍有合并前已观察到的同一 Git transport 失败，全仓检查未完整通过。

[可用性决定](../bug-fix/2026-10-29-inbox-no-durable-block.zh.md) 取代启动 PID 证明、持久阻塞与离线人工恢复。
旧理由保留在[归档记录](../../archived/bug-fix/2026-10-21-manual-inbox-recovery.zh.md)。未知提交仍不重放，排队输入和结果保留。

准入锁同时计数等待者与持有者，仅在引用为零时移除；投影缓存跟随 SQLite 保留的回执清理。reconcile 使用具名 tracing，删除五处非空断言，明确 50 成员预览上限，release 重试使用自己的回执，不修改调用方事件。Scope 失败恢复保持原行为；注释明确底层延迟成功不会替换首次失败回执，没有证据支持重复 Scope.close 或改变 coordinator dispose。

已完整读取 head `86553a65e` 的 Actions `38378067632` 与 `38378068245`。实际 checkout 是基于 `567afa18d` 的合并提交 `7ae334e`，不是独立 PR head。七个 CI 分组及 Desktop smoke 都在测试前安装失败：main 更新 ACP gitlink 后未同步根 pnpm 锁文件；Tests 汇总及找不到 Playwright 的视频步骤是后续连带失败。检出准确 gitlink 后，本地 frozen install 复现相同九项 Claude manifest 不匹配。

重建锁文件随后被现有七日发布年龄门槛阻止。34 个候选 artifact 的 registry integrity 均已与 main 子模块的已提交锁文件一致性核对，实际只有 11 项需要例外：ACP SDK 1.8.0，Claude Agent SDK 0.3.293 及八个平台 artifact，Anthropic SDK 0.132.1。提案只添加精确版本、保留通用门槛。自动审批以未获得明确供应链例外授权为由拒绝了应用；尚未修改例外或锁文件，修复等待用户决定。已尝试 pnpm check，但 Claude adapter 对旧已安装 SDK 编译失败，不能作为升级后依赖图的验证；docs 和 format 通过。另修复两个被上游移动的 Codex 测试证据链接，不改变 Spec 意图或批准状态。这些运行是安装失败，不是 Inbox 测试失败，也不能作为桌面验收证据。

## 当前提交本地验证（2026-10-13）

在 `58d2e34b3` 上，16 个 suite、371 项测试通过：Inbox、Coordinator、Operation store 和 dispatch watcher 共 204 项；竞争模型、进度和 MCP 共 107 项；shared 控制文档、协议和前向兼容共 23 项；组件控制文档、发送资源、派发状态及持久用户发送共 37 项。真实 Host socket／资源测试在沙盒禁止 socket 后，已在沙盒外重跑。CLI、shared、components 的直接类型检查及根 `check:quick` 通过，使用的是现有已安装依赖，不能证明 main 升级后的 ACP 依赖能全新安装并通过验收。

Session execution 和 Fleet suite 在导入时失败：main 的 Codex adapter 声明 `@openai/codex` 0.160.1，但已提交运行时清单仍为 0.159.2。base `567afa18d` 也包含同一清单；仅重新安装无法修复这项源码契约不一致。根 `pnpm check` 还在使用旧已安装 SDK 编译新 Claude 源码时失败。没有绕过运行时校验；桌面构建／smoke 与当前提交完整验收仍被阻塞。

Inbox 调度和 SQLite 是机器本地状态，但输入准入还消费同步的 Session 文档字段 `humanInputReceipts`、`cancelRequest`、metadata 取消标记，以及客户端到机器的 RPC。因此，本地调度不代表没有客户端／CLI 混合版本边界。现有 Stop 协商与 Operation 保留行为未改；本次未扩大做旧客户端二进制或整机升级验收，已有 SQLite 升级回归包含在 Operation store suite 中。

## 验证与剩余边界

ACP base 升级前（head `86553a65e`）已在作者工作树实际安装和检查：Node 24.21.0、pnpm 10.20.0、锁定 Effect 4.0.2。`pnpm install --frozen-lockfile` 成功，锁文件未变。安装 guard 允许此 checkout，之前把它当成嵌套工作区是不准确的。先前隔离副本结果只保留为历史证据，不是独立 base/head 审核；重叠范围不能累加。

| 范围 | ACP base 升级前实现证据 |
| --- | --- |
| 作者工作树相关交集 | 5 suites，413 项通过：Inbox、Coordinator、执行服务、dispatch watcher 与 Fleet。最终 Inbox 单独复跑 51 项通过，包含五个人工恢复场景及冻结调用方事件的回归验证 |
| 准入反证 | 此前隔离副本的两个确定性竞争位置：移除提交锁均失败，恢复后均通过；保留未知提交禁止重发断言 |
| SQLite／所有权 | 内存共享连接的完成事务、失败回滚、异步事务拒绝；磁盘重开、资源释放和共享关闭恢复沿用行为覆盖 |
| 类型／静态／格式 | 作者工作树全仓类型检查、lint、format、check:quick 通过，原生内核边界检查通过 |
| pnpm check | 作者工作树实跑未全绿：类型与 lint 通过；CLI 4142 通过、4 跳过、1 项 Git transport 失败（context_unreadable／remote helper aborted）。transport 源码和测试均未相对 main 改动；未独立复现基线，递归检查终止，不能宣称全仓测试通过 |
| 文档 | 作者环境 docs check 通过；此前 82 项缺失链接为历史结果，原先缺失的子模块源码现已存在 |

CLI 默认编辑器项目现已收录源码与测试，让两者共享 `@/*` 别名；生产类型检查明确使用 `tsconfig.typecheck.json`，保留原排除范围。实际 TypeScript language server 探针确认 src 内测试和 tests 目录文件都进入配置项目并正确解析 timeout-utils，不宣称修复其他测试类型错误。两个测试清理入口补齐等待 Coordinator 关闭后再关闭 SQLite，相关 144 项通过。全仓类型、lint、format、quick 边界及文档检查通过；全仓检查仍被下述同一 Git transport 失败终止。

测试通过 Deferred、注入时钟、fake timers 和故障触发器检查完整模型输入、持久行与真实释放。覆盖八项合批、空边界、迟到第九项、无新事件重开、暂停／未知不重发，以及当前调度所有权与资源释放。旧协调器 fixture 的早期移交测试随被退役的契约删除，不能充当新版验收。资源测试使用真实独立进程组，进程表为注入快照。不宣称真实模型、完整系统进程表、桌面端到端、合入或发布验收。

修订候选仍待独立复审，Spec 保持 draft。未来 Lody 各落地端和 Agent adapter 都完整支持 ACP steer 后，再评估执行中合批交付，并验证实际应用、暂停、取消和未知交付。这是维护条件，不是当前行为或定时提醒。

[PR #1523](https://github.com/LodyAI/Lody/pull/1523)。

## 回执驱动空闲唤醒修订（2026-10-13）

用户实测发现 A 委派给 B 后先结束，旧的“结果到达不唤醒”规则使预期续接无法运行。用户批准队列唤醒标记方案。现有 `automatic_eligible` 表示启动资格，不再过滤批次成员。完成事务在空闲、未暂停、资源未阻塞且没有已接受输入时记录一个合并的持久意图；认领时原子取当前队列水位，包含可唤醒及被动结果。已准备／已提交／提交未知批次保持成员固定和不重放，用户输入及 Stop 保持优先。Spec 仍为 draft。

保留真实 SQLite 回滚、双连接认领、进程重开、真实释放和不重发覆盖；原释放时固定水位的断言改为认领时合批，认领后到达仍进入下一批。Coordinator 替身现在结算真实提交回执，不再只写模拟输出。作者工作树交集 4 suites／158 项通过，覆盖意图失败原子回滚、被动加可唤醒成员合批、认领后隔离、暂停／未释放重启、重复与未知提交不重发。直接 CLI 类型、根 check:quick、格式和 docs 通过；根 pnpm check 仍在已有 Claude 源码与已安装 SDK 不匹配处失败，不是全仓验收。Cloud 集成与桌面交互是单独的验证边界。

Cloud 合成使用相同 PR 生产代码，加上已记录的本地 SDK／运行时 pin 对齐，没有上传远端运行时。Inbox／Coordinator／Session／dispatch／Fleet 五个 suite、417 项通过。Session 用例观察第九条空闲回执触发第三次 provider 输入，且不再包含已消费八项；走原生队列唤醒，不直接手工调用续跑。CLI／renderer 构建、打包 native smoke 和临时签名验证通过。这是本地 production-cloud 集成构建，不宣称根 CI 安装、交互登录或真实模型验收。

## ce194f5a 的本地 CI 复现（2026-10-13）

验证固定 PR 源码 `ce194f5a030e274846b001b2e32fb8476f2c1414` 和 base `567afa18d1f0d45ebbe78fca7dde2a5dde3a7536`；没有合并 main，也没有对齐依赖或运行时清单。冻结安装失败后使用现有已安装依赖。Components 在 Node 22.18.0 上通过 564 个文件／5194 项。使用已核对官方归档校验和的 Node 22.23.1，工作流的完整 rest 组通过，其中 Shared 1477 项、Electron 219 项；两个对话浏览器 spec 的 18 项全部通过。CLI 执行的 3276 项通过、3 项跳过，但 48 个 suite 因 Codex 清单 0.159.2 与 adapter 0.160.1 不一致无法导入。Inbox 的 55 项在完整 CLI 执行中通过。跳过 adapter 预构建后的各包类型检查、check:quick、format:check、文档检查、贡献策略测试和桌面 suite 契约均通过。

冻结安装仍报告 Claude importer 与锁文件有九项依赖不一致。根 pnpm check 与 OSS 桌面构建均在使用旧已安装 SDK 编译 Claude adapter 时失败，桌面 smoke 因此未启动。相关 ACP gitlink 与 Codex 清单和固定 base 完全一致。这些结果不证明干净安装、Linux CI、PR 合并树或桌面验收通过。

首轮环境差异单独保留：继承的 GIT_EXEC_PATH 使 Git 指向当前会话凭据包装器；仅移除该变量后，原生 Git 的 18 项全部通过，完整 CLI 复跑也通过。Node 22.18.0 缺少一个 Shared suite 所需的 WASM 加载行为，22.23.1 通过。首轮 Node 24 并行运行有两项人工恢复测试失败，随后两次 Node 22 完整执行与 Node 24 单独复跑均通过；不抹掉首轮失败，也不声称已证明其根因。人工恢复 adapter 会拒绝进程快照的任何警告，包括可选 macOS 内存探针警告。没有放宽生产恢复检查。

## 同步 main a4270dd81（2026-10-13）

沿用分支既有的 merge 方式，把 main `a4270dd8162f94f60c13ed55eba4a5c7bcb0b1c8` 合入 PR head `ad8b4a4ec40ab906fcd5c03de097135856dcc358`。同时保留 Inbox 准入／回执与 main 的独立额度刷新，两项协议能力和两组追加的执行测试均保留；额度测试组与 main 完全一致。机器注册的完整清单断言补上额度能力。Codex 证据链接按恢复后的 adapter 修正，不改变 Spec 意图。

main 的额度刷新合并在运行时 pin 回滚后重新带入升级过的 ACP 锁文件。冻结安装发现它与恢复后的 gitlink 不匹配；重新解析也会触及未改变的发布年龄门槛。因此恢复 `c10ca8561` 的兼容锁文件，该版本的依赖声明与 workspace 配置和本次合并一致，package manifest 唯一差异是 PR 的 CLI 类型检查脚本。额度刷新没有新增依赖，功能继续保留；没有额外升级、发布年龄豁免或运行时发布。

冻结安装、完整 pnpm check（含 CLI 4162 项通过、4 项跳过）、format／format:check、针对 main 的文档检查与 GitHub 策略测试 113 项均通过。执行／Inbox／机器注册交集的 358 项也通过，与完整检查重叠，不能累加计数。CLI 在 2 GiB 堆限制下构建并通过发布包 import 检查；OSS 桌面构建及 smoke 的 6 个场景／40 个步骤全部通过。验证使用 Node 22.23.1、原生 Git helper 和 CI 的签名配置。没有放宽运行时校验、发布年龄策略或测试断言。推送后对应 head 的 Actions 与真实模型／Cloud 产品验收仍是独立证据。

## 手动停止目标时静默结束（2026-10-14）

用户要求：停止 B 中被委派的 turn，不应唤醒发起方 A。保留 Operation 查询中的取消状态，但自动模型回执过滤掉手动停止的目标；混合批量只回传剩余目标。Stop 在机器本地 Inbox 输入中记录原因，由 HistoryWriter 写到精确 user turn，供远端协调与迟到输入恢复读取；不新增 Session metadata 字段或 RPC。保留 Effect 准入与 SQLite 事务边界，筛选是纯函数，I/O 仍在现有 platform adapter 中。终态与已消费结果墓碑在同一个事务中提交，防止重启、重复 finish 或后来用户输入补发，并保留清理资格。目标的新任务相互独立；非用户取消、失败和超时仍按原规则回执。

验证：冻结安装与完整 pnpm check 通过，CLI 4181 项通过、4 项跳过。最新 Inbox／Coordinator 交集 96 项通过，包含墓碑写入失败的事务回滚；shared HistoryWriter／peer 投影交集 63 项通过。以上计数重叠，不能累加。本次回执策略变更未重复运行真实模型与桌面验收。

原生 OperationRepository 在读取旧目标历史与 deadline 降级前核对精确输入的本地取消记录。真实 SQLite／Coordinator 测试覆盖了输入已停止、历史仍有部分终态输出且 deadline 已过的窗口；远端协调读取持久历史中的原因。

完成事务持有 SQLite 写锁后重新核对 Stop，并在索引前同时规范化持久目标状态与完成结果；预先算出的成功不能越过已经提交的停止。完整检查仍通过，最终 Inbox／Coordinator／Store 交集 156 项也通过。

后续实现：[PR #1553](https://github.com/LodyAI/Lody/pull/1553)。

## 确定性的操作员恢复验证（2026-10-17）

## 已取代的人工恢复

[可用性决定](../bug-fix/2026-10-29-inbox-no-durable-block.zh.md) 删除人工恢复工作流及其进程探测测试。
保守的释放证明可能让对话无限期不可用；进程清理现在与准入分开。

## 数据库启动降级

SQLite 打开／激活失败归可选的 coordinator 处理，不能阻断工作区启动。普通人类
输入沿用无 Inbox 的路径；依赖它的工具在访问数据库前读取 daemon 当前可用性，
包括已缓存的连接，避免接受无法调度回执的任务。应用入口持有一个启动重试定时器，
从 30 秒倍增到最多 10 分钟；任一步同步初始化失败都立即撤下 Inbox，并沿用停止流程关闭部分初始化的资源后再重试，不取消或等待普通回合；stop／recoverStop 取消定时器。
schema/protocol 不兼容需要兼容版本，因此不自动重试。恢复后清除本地运行时提示。
已有未知提交和资源释放规则继续生效；降级不能证明资源已释放。启动仍由已登记的
应用入口负责；迁移尚未完成的 Session/ACP 适配器会扩大修复，不能改善本次边界。
coordinator、MCP 和执行测试覆盖启动失败与恢复；已安装桌面与真实磁盘满验收仍需独立完成。

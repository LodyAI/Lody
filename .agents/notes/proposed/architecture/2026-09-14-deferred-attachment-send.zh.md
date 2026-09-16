# 附件 draft 的生命周期与 PR 边界

Status: proposed
Translation: current

[English](2026-09-14-deferred-attachment-send.md)

## 摘要

当前附件添加即传，输入组件卸载和失败后的提交容易影响完整内容。draft 功能统一新建与继续对话：添加只校验/预览，发送后由独立服务接管，全部附件就绪才提交。建议用锁定的 Effect 3.18.4 分四个 PR 接入：先抽提交边界，再管理资源，再落实提交/投递，最后同时交付完整 draft；前三步保留添加即传，代价是功能交付前需要完成持久化、恢复与退出边界。本机原路径引用、永久零上传及相关协议/Daemon 工作仍独立到后续 PR。六个实验验证了部分取消与资源边界，其中两项使用实际 store 缓存；本次仅更新设计，尚未实现或完成产品验收。

## PR 边界

[附件 draft Spec](../../../../specs/session-files.zh.md)是当前 PR 的意图入口。新对话和继续对话必须使用同一接管、准备、重试、取消契约，但创建会话与继续发送保留各自最终提交适配。两个入口都要经过完整 UI 验收，不能只验证共用 helper 或只完成 landing。

[本机直接引用 Spec](../../../../specs/local-attachment-references.zh.md)独立保存后续 PR 的设计：原路径引用、生成内容本机保存、授权登记、新附件协议、Daemon/适配器/预览与兼容，以及禁止后台补传。这些不属于当前 PR 的实现或验收门槛。当前 PR 延后调用既有云端上传或本机 handoff，保留既有附件类型、fallback、backfill、物化和平台能力边界，不承诺同机附件永久不上传。

这替代本提案初稿中将 draft 与新本地引用协议一起实施的范围划分；后续 PR 接入同一准备边界，不复制草稿状态机。此拆分降低本 PR 的改动范围，但不减少当前 draft 的失败、取消、退出和恢复要求。

## 当前源码与取舍

基线：`8c429a890037c5b21855ce7ef9f59e3677c25a38`。

- `session-chat-input-area.tsx` 和 landing hooks 均在添加后传输；普通文件失败会被过滤，图片失败则阻止发送。当前 PR 将两类入口统一到全部附件就绪的提交条件。
- `use-session-actions.ts` 每次生成 turn ID，`HistoryWriter.append` 不按 ID 去重；首次 meta/history 并行写。固定 ID 与结果核对、持久交接需一起落实。
- 组件外仅存内存任务能支持页面内切换，却不足以覆盖移动壳回收；因此保留本机恢复记录，保存失败保留草稿，不等同于系统后台上传。
- Electron 退出确认仍要先于 relay/CLI 清理。这是 draft 生命周期责任，不随本机通信优化一起延期。
- 沿用现有本机 handoff 可以独立交付 draft；该路径的复制和补传是后续 PR 才改变的传输行为，不能在本 PR 文案中暗示已消失。

没有检查本仓库之外的移动壳或私有上传服务；复用接口是实现方向，不是已完成集成验收。

## Effect 方案与取舍

[Spec 第 11 节](../../../../specs/session-files.zh.md#11-effect-ts-落地方案与实施顺序)将接入范围定义为 workspace 的准备、提交、投递流程。React/Jotai 继续拥有草稿与短接管/焦点 token；CLI 拥有 Agent 与 backfill。Scope 依释放边界分组，Ref.modify 只是统一状态操作的可选写法，封装普通变量同样可行；不把 Ref 当作跨 I/O 事务或跨窗口锁。

本轮沿实际调用链补充了这些结论：

- `useComposerSubmission` 的挂载生命周期还管键盘/焦点；`session-chat-input-area` 的成功回调同时清草稿和触发视觉批注已提交。因此“保存并接管”和“真实消息接受”必须拆开，否则会过早改批注、长时间锁输入框或夺回焦点。保持现有移动端点击即收键盘，数据保存成功才清理。
- `session-detail.handleSendDraft` 将子会话创建、tab 升级、导航和失败删除绑在一起，且读取当前父会话。需要冻结父关系与 ID、恢复升级别名，导航失败不能删除已写子会话；landing 不是唯一新会话入口。
- `useSessionPreparation.handoffToSession` 只清引用/计时器，不能跨上传管理资源。首版附件接管时停止预热并由服务收尾精确取消，真实发送可冷启动；保留 CLI 硬 TTL、兼容 claim 和无附件的已有复用。
- `workspace-writer-impl` 的首次 meta/history 并行，dispatch 参数被忽略；`use-session-actions.requestSessionDispatch` 另起同步 Promise、完整输入 RPC 和 meta 指针写入。需抽无 UI 提交适配器和独立投递所有者，不能把旧注释的“durable accept unit”当成当前证明。
- CLI `SessionDispatchWatcher.offerRpcTurn` ACK 表示暂存/去重接收，不是执行或落盘收据；RPC 实际带完整输入，可以先执行。`TurnHistoryGate` 等用户历史后再写输出，故 ACK 后仍需同步历史；保留 CLI 的执行和去重所有权。
- `createSessionStore` 的 store 引用与 room sync lease 独立；`store-ref-tracker` 才负责 dispose/unload。Effect finalizer 只退本次借用；准备/离线等待不保活完整历史，获取晚到也不能漏释放。`acquireRelease` 的获取阶段默认不可中断，不能套在无界获取上就宣称退出可控。
- `waitUntilSynced(signal)` 在 abort/detached 下可直接返回，transport-ready 等待尚未贯通信号；必须区分同步成功、跳过、中断和未知。为投递尝试借用现有同步资源，不另造每消息 transport/reconnect。
- `session-chat-interface` 的 MCP、Role、工具开关、resume、billing guard、presence 与 direct 锁来自组件。提取后冻结用户选择，复查运行事实；所有普通新消息都遵守 FIFO，保留未完成历史的 queue 屏障。guide 的 false 混合多种结果，权威 no-active-turn 与未知结果必须分开。
- `resolveWorkspaceRuntimeCacheIdentity` 的 repo/cursor 按窗口隔离；另一窗口空副本不能证明未发送。现有 token 更新不必销毁服务，账户/拓扑切换则需旧代次退出保护。
- 图片取消、multipart 无人等待的清理、不可取消 IPC、runtime/Electron 关闭顺序仍须调整。main 临时文件、CLI blob/backfill 的所有权和既有传输语义保留，本机跳过上传仍是独立 PR。

拟采用一个 ManagedRuntime，按存储、传输、提交三个依赖边界组装；持久交接后继续保留较小的投递义务记录，不让上传 Scope 结束时把投递一起中断。主要代价是要定义真实持久化/同步收据、跨窗口恢复来源和副作用触发时机；不是把现有 Promise 逐个换成 Effect 就结束。只处理耦合边界，不重写无关重连/缓存/Daemon。

## 渐进接入与回退

[Spec 第 11.6 节](../../../../specs/session-files.zh.md#116-分阶段接入与验收)建议三个前置 PR 加一个完整 draft 功能 PR，按职责完成后再合并：

1. 抽取普通提交接口，保持当前行为；基线用例覆盖真实输入/配置/路由，已有缺陷保留为反例及后续修复项。
2. 在服务内部用 Effect 完整管理迁入的上传、取消、重试、借用与释放；组件仍用普通接口，添加即传时机不变，退出收尾随资源一起交付。
3. 接管已准备消息的提交与投递，落实身份、持久化收据、未知结果核对、跨窗口恢复及必要的退出流程；明确这是可靠性行为改进，仍不切换上传时机。
4. 同时接通新建、子会话与继续对话的完整 draft，包括保存、失败、取消、顺序、预热和各端退出/恢复后再启用。

每迁移一项职责就删除旧所有者，不双跑真实上传/写入，也不在未知结果后退到旧发送路径；不同时升级 Effect、重写底层同步或实现本机零上传。其取舍是晚一些改变产品体验，换取每一步可独立核对行为、取消和资源边界。开始保存恢复记录之后，回退只能使用能处理这些记录的兼容版本；须先停止接管并结束或可靠保留在途工作，不能靠删除记录或重发清场。原副本恢复及记录兼容未确定时，不发布该持久化阶段。

## 相关决定

- 延续[工作区草稿隔离](../../implemented/bug-fix/2026-09-11-workspace-window-composer-drafts.zh.md)：新建和已有会话草稿均不跨账户/工作区泄露。
- 延续[唯一历史 writer](../../implemented/architecture/2026-09-07-single-history-writer.zh.md)，不引入另一套历史写入。
- 保留[上下文复制](../../implemented/feature/2026-09-09-conversation-context-fallback.zh.md)所确定的折叠文本与发送前展开，自动文本转文件及图片编辑器不随本 PR 引入。

## PR 栈实施状态

PR 1: [#705](https://github.com/LodyAI/Lody/pull/705) — `refactor/attachment-submission-boundary` → `main`.

第一层从 `use-session-actions.ts` 提取 `lib/session-submission.ts`，React
保留额度准入、统计和 atom 观察绑定。创建、首条历史、继续发送、dispatch 与
guide 仍使用同一 writer 和路由，上传时机与接受行为不变；这一层不启用持久
发送服务或 draft 产品行为。基线已纳入 main 的粘贴大小上限（`6fde8b07`）。
验证使用现有 actions/composer 套件，将仅检查 writer 调用的用例改为核对真实
返回并可读的首条/继续对话历史结果。

第一层验证：全仓类型检查和 lint 通过；components 3,656 项、shared 1,194 项、
Electron 112 项通过。完整 `pnpm check` 在无关 CLI worktree-GC 用例比较 macOS
`/var` 与 `/private/var` 路径别名时停止，其余 CLI 2,791 项通过；使用
`TMPDIR=/private/tmp` 重跑该完整套件，11 项通过。剩余 i18n/import/platform/
public-boundary 检查及文档检查分别通过。已运行 `pnpm format` 并撤销无关格式
改动；不宣称完成打包设备上的 draft 验收。

## 验证与限制

[有限模型](../../../../specs/models/session-files.model.ts)只覆盖当前 draft 范围：两入口的添加/移除/替换/导航/发送门槛、双附件就绪组合，以及同会话两条已接管消息、各至多一次重试的有限状态图。接受回执与持久交接分开；检查取消、过期回调、FIFO，并保留旧失败文件过滤规则的反例。本机零上传路由已从当前模型删除。

运行 `node --experimental-strip-types specs/models/session-files.model.ts`，以及 `tsc --noEmit --strict --target ES2022 --module ESNext --lib ES2022,DOM --skipLibCheck specs/models/session-files.model.ts`。模型不连接真实 UI、writer、磁盘、IPC 或 Agent；新对话与继续对话的完整验收按 Spec A01–A18 执行，不能用有限模型代替。

[Effect 实验](../../../../specs/models/session-files.effect-probe.mjs)使用锁定的 3.18.4，六项通过：非配合 Promise 中断后仍写入、signal 停止受控传输、Scope 等待异步清理、状态/代次检查，以及使用当前 `store-ref-tracker.ts` 验证晚到获取的释放和共享 UI 引用不被误销毁。后两项使用合成 store；没有真实 Loro、磁盘或网络。释放用显式闸门与 releaseIfIdle 触发，不依靠真实 sleep 或定时器碰运气。

复现：临时目录安装 `effect@3.18.4`（`npm install --prefix <temp> --ignore-scripts --no-audit --no-fund effect@3.18.4`）；按仓库相对路径复制 `specs/models/session-files.effect-probe.mjs` 和 `packages/components/src/providers/store-ref-tracker.ts`；运行 `node --experimental-strip-types --test <temp>/specs/models/session-files.effect-probe.mjs`。只证明这些边界，不证明真实图片 XHR、IPC、writer 持久化、多窗口协调或 E01–E12 已验收。官方 v3 资料及当前源码入口列在 Spec 末尾。

最初设计工作树有 20 个未初始化 ACP 子模块导致的断链错误。独立实施 checkout 已初始化锁定的子模块，文档检查现在为零错误，没有注册的 SHA 保护主题。第一层的三个 actions/composer 套件共 69 项通过；全仓验证与 PR 链接随栈实施状态记录。完整 draft 产品行为和设备验收仍未完成，Spec 保持 draft，本 Note 保持 proposed。

## Layer 2 implementation

第二层为工作区创建一个 Effect 资源所有者；文件准备、图片上传及发送时的 store 借用都由它管理。React 仍使用 Promise 接口，切页不取消上传，工作区关闭先取消并等待任务，再关闭缓存和传输。不能取消的 IPC 必须结束后才能释放依赖。文件准备在新对话和继续对话间共用；取消不能触发备用上传，multipart 清理必须等待。

新增确定性测试覆盖并行取消、迟到的 store 获取、兄弟任务隔离、XHR 实际取消及上传进度与成功响应的区别。该层保持添加时上传；持久化发送和完整 draft 行为仍属于后两层。

第二层验证：`TMPDIR=/private/tmp NODE_ENV=test pnpm check` 全部通过（组件 478 个文件、3,661 个测试），`pnpm format` 和 `pnpm run docs check` 已完成；文档无错误。仍未声称完成真实设备上的 draft 验收。

第二层 PR：[#707](https://github.com/LodyAI/Lody/pull/707)，基于 #705。

第三层正在实现。为关闭“已追加历史但磁盘确认丢失”的窗口，在同一个 HistoryWriter 抽象内先在临时 fork 准备操作，保存原副本名称及原始操作字节，然后才导入当前文档。重启重放相同操作，不重新 append。先 flush 原副本以保留操作依赖；跨窗口恢复先读取原副本，缺失时保留记录并停止，不以新窗口的空历史推断未发送。真实 Loro 测试已覆盖两副本重复重放、缺失依赖与校验失败；运行时、退出、UI 以及完整 IndexedDB 验证仍未接完，不能发布这一层。

Layer 3 validation: full `TMPDIR=/private/tmp NODE_ENV=test pnpm check` passes, including 479 component files / 3,670 tests. Queue preparation uses the existing WorkspaceWriter and retains queue format. 原生 queue-steer 复用已有的 queued journal 条目，不会再添加冲突的 `pending_apply` 副本；guide/delivery 改写该已有条目并保留其恢复身份。`pnpm format` and docs check completed; docs report zero errors. No packaged-device acceptance is claimed.

跨窗口接管时记录实际准备操作的副本；接管输入的窗口不一定拥有原操作基线。确定性 journal 测试覆盖此恢复边界。

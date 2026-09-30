# 附件 draft 的生命周期与 PR 边界

Status: implemented
Translation: current

[English](2026-09-14-deferred-attachment-send.md)

结论（2026-09-29）：已实现。四层改动已通过 #705、#707、#709 与 #719 合并，因此本记录从 `proposed/` 移出。已被[移除会话发送日志](../simplification/2026-09-29-remove-session-send-journal.zh.md)部分替代：持久发送日志、跨窗口恢复、恢复记录兼容以及退出/登出/清缓存拦截均已删除，等待附件的发送现在只保存在内存中。发送时准备附件、workspace 的 Effect 资源所有者以及提交边界仍然保留。下文为历史记录。

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

[Spec 第 11.6 节](../../../../specs/session-files.zh.md#114-分阶段接入)建议三个前置 PR 加一个完整 draft 功能 PR，按职责完成后再合并：

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

Layer 3 validation: full `TMPDIR=/private/tmp NODE_ENV=test pnpm check` passes, including 479 component files / 3,670 tests. Queue preparation uses the existing WorkspaceWriter and retains queue format. 原生 queue-steer 保留 queued journal 的身份，但会先将已经投递的 queue 操作提升回已保存的 history 工作；删除 queue 行前，完整的 history 意图已经持久保存；guide 投递前才完成 history turn 的准备和提交。删除 queue 行到 history 提交之间崩溃时，从该已保存意图恢复。prepared 或 committed 记录只能在披露后显式丢弃；退出登录/清缓存会写入强制清理标记，并在下次启动时实际删除恢复数据库。被恢复记录阻挡的非强制清理会保留请求，但不会阻止 runtime 初始化；一次性 native reset 请求也会在延后前复制为本地启动标记。`pnpm format` and docs check completed; docs report zero errors. No packaged-device acceptance is claimed.

## 第四层实现

第三层已提交 [#709](https://github.com/LodyAI/Lody/pull/709)，基于 #707。第四层让首页、已有及子对话输入框都在 Send 后才准备附件。IndexedDB 确认保存不可变 Blob 快照后释放输入框，本地元数据覆盖层保持新对话入口可达，不提前发布。共用逐文件结果保存、重试、取消和同会话顺序；准备完成后重新检查当前资格。导航或偏好保存失败不能把已接管消息变回可重复发送的草稿，活动更新也不能提前写入残缺的新会话。

预热取消等待原启动及清理结束。持久化取消保护跨窗口迟到结果，取消第一条消息会把建会话信息交给下一条；后续接管也保存该信息，覆盖取消与下一条保存同时发生的情况。version 2 阻止旧读取器发送不完整输入；与操作一起保存实际准备窗口的副本标识。已经结束的 Guide 目标改为后续输入；先前提交结果未知时只核对，不再次 offer。

待发送的主要展示属于对话消息流，工作区恢复面板已移除；在会话之外，桌面侧边栏行显示本地的发送中/失败标记，未发出的新会话标题显示为灰色（[侧边栏发送状态](../feature/2026-09-28-sidebar-send-status.zh.md)）。点击发送后，新对话立即打开，已有对话留在当前页。在 history 可提交前，本机待发送记录按普通、右对齐的用户消息行渲染：附件预览/卡片各自显示准备或上传进度，消息行说明正在等待发送；失败仍保留同一行并提供重试/取消。中断准备的重试、取消和带披露的丢弃入口都放在消息行内，在移动端抽屉中也可访问。

验证：最终 `TMPDIR=/private/tmp NODE_ENV=test pnpm check` 通过，含 480 个组件测试文件、3,677 项测试；随后资源与预热定向测试 9 项及组件类型检查通过，覆盖空闲预热不触发未保存输入提示。重排及并发接管修正后，定向测试 60 项和组件类型检查通过。根格式化、组件 Prettier 和文档检查完成，文档零错误。打包设备、多窗口真实网络及原生移动壳尚未验收；本文仍为 proposed，不推断人工批准。

跨窗口接管时记录实际准备操作的副本；接管输入的窗口不一定拥有原操作基线。确定性 journal 测试覆盖此恢复边界。

## Pending 失败层级

最初的 pending 行会把同一失败显示三次：消息级“未发送 · 附件上传失败”、record 的 `error` 以及每个失败附件自己的原因。部分失败因此像诊断输出，而不像一条消息。现在每个事实只有一个展示所有者：

- 消息级只保留一个短状态：`sessions.pendingMessageUploadFailed` 只显示“未发送”，并使用 `text-muted-foreground`。图标与文字已经表达含义；再把这行染红会在同一条消息里堆出三个红色信号。
- 失败原因属于失败附件。只有没有附件携带原因时才显示 record 级原因，因此所有附件已就绪但 journal 失败时仍有解释，同时不会重复。
- `FAILED_FRAME_CLASS`（`border-destructive/30 bg-destructive/[0.04]`）是失败的全部红色预算，且只由失败卡片使用。图标块、文件名和消息状态保持中性；整行只有卡片边框、一个 `AlertCircle` 和一条原因文字为红色。图片卡片用中性的 `bg-background/55` 遮罩保证任意照片上图标可读，不使用红色蒙层。
- 没有卡片承载的原因使用 `PendingFailureNotice`，即 notice 尺寸的同一容器，而不是气泡下方零散的红字；重试或取消动作失败也复用它。
- 已完成附件保持普通 Ready 卡片，因此部分成功仍清楚可见。文件卡与已投递的 `SessionFileCard` 共用 `getSessionFileIcon`，draft 与最终形态读作同一对象。
- 上传、就绪、失败共享同一骨架：图标槽、名称加一行状态、尾部状态图标。进度条是贴在卡片底部的满宽流式条，始终占相同高度，非传输状态为空，保证三种状态高度不变。此前把它绝对定位在 padding 内会覆盖 40px 内容行并留下无关间隙，已移除。图片卡片把同一条放在缩略图和说明之间。量得图片卡始终为 198px、文件卡始终为 66px。三个尾部图标始终挂载，以 opacity/scale/blur（0→1、0.25→1、4px→0）在 300ms 内交叉淡入；只用 CSS 明确声明这些属性，不把 framer-motion 引入对话模块图。
- 图片预览使用 1px `outline-black/10 dark:outline-white/10` 边缘；带色中性边会吸收下层表面颜色，看起来像污渍。
- 两个动作不加按压缩放：共享 `Button` 与周边编辑、置顶、复制控件都没有这种反馈。
- “继续发送”是主动作，“取消发送”是 ghost 次动作；二者紧贴消息放在同一行，而不是独立的控制条。

这只是渲染变更，不改变 journal stage、Effect 生命周期、重试/取消语义、顺序或持久化。`PendingMessageRow` 导出为纯组件，使 Storybook 与 `tests/session-pending-message-row.test.tsx` 不需要 workspace runtime 即可驱动所有状态。回归测试已分别删去重复原因和统一 destructive 样式以确认会失败；ready-file fixture 用来覆盖仅有 ready image 看不到的文件卡回归。已用组件 typecheck、`lint:i18n`、oxlint、完整 481 文件/3,684 测试组件套件，以及 720px 和 380px、浅色和深色的 Storybook 截图验证。浏览器中读取过交叉淡入的 `opacity`、`scale`、`filter` 与 `transition-property`，没有靠假设。两次 mutation 最初静默通过，现已有对应断言：消息状态重新着色、以及移除保留进度行。进度行通过 `data-attachment-progress` 断言，因为 `Progress` 最终合并为同样的 `h-1 w-full`，仅靠样式不能区分；jsdom 没有布局，因此等高先用结构性断言守住，再在浏览器中测量。

## 原位发送（2026-09-29）

在新对话里把图片作为第一条消息发送时，对话流会被加载骨架屏占满，pending 行被压在底部；提交后两者又被一个形状不同的行替换。骨架屏并非真实加载，而来自内容同步状态：创建元数据已带 `lastMessageAt`，而 history 在上传提交前一直为空，于是对话流被判为“有消息但无缓存”（`cold`）。空对话流还把空状态布局为 `flex-1`，把尾部内容推到最底。

- 当 `sessionUnsentNewConversationAtomFamily` 为真且 history 为空时，pending 行本身就是对话流的空状态，位于顶部、即提交后该轮落下的位置，且不再同时作为尾部内容传入。该 atom 只在第一条消息写入时变化，页面级订阅成本很低。
- `PendingMessageRow` 现在与 `UserMessageRowView` 对齐：头像列（同一 `getUserById` 查询，因此是同一缓存头像）、宽度与容器查询上限、`py-2 sm:py-3` 列、由时间戳加状态槽组成的元信息行（状态槽就是已投递行绘制已读标记的位置），以及使用对话字号的同一文字气泡。提交因此只改变该状态槽：从“等待发送”变为未读/已读标记。
- 这部分替代了上文的图片卡片决定：图片改用已投递形态的边框（单张按原始比例、最高 10.5rem，多张为大尺寸方块），进度条贴在底边，不再有说明文字，因为说明文字正是提交时整行丢失的高度。失败图片的原因因此经由行级 notice 呈现；文件卡保留说明文字，仍是原因的展示所有者。
- 动作行始终占 28px 的流式高度，与已投递行悬停显示的动作行一致，提交时下方内容不移动。
- 写入先到达对话 view，暂存的发送随后才被移除（最初是先于 journal 记录提交；#1118 之后是先于内存列表删除它）。`SessionPendingMessages` 会隐藏 id 已在对话 view 中的发送，并通过字符串快照避免随 token 频率的 view 变化重渲染。否则续聊在这段间隔内可能把同一轮显示两次。

已用组件 typecheck、pending 行测试套件（一个测试在 history 更新后暂停写入，删去过滤即失败）以及 720px 和 380px、浅色和深色的 Storybook 截图验证。合并主线本地优先发送（#1118）后已重新验证。遗留限制：已投递图片提交后仍会从服务端获取缩略图，期间显示自身的加载块；用已上传的 blob 预填该缓存是另一项改动。未在打包应用或原生移动壳中验证。

## 主线整合（2026-09-27）

已整合主线 `ef242986`。主线输入框等待上传的流程改为立即持久接收 draft，后续传输由 journal 管理。保留当前发送路由及 Queue 反转快捷键、作用域隔离、防重复提交，以及逐字段保护后来替换的草稿。输入框测试改为验证完整附件快照、接收失败重试、仅附件发送和阻断状态；传输与恢复失败继续由 preparation/journal 测试覆盖。保留主线按 key 虚拟列表、回复留白滚动、图片预览和当前 UI 组件。renderer 收尾接在现有 CLI 退出屏障之前，取消时服务不停止，CLI 停止失败仍保留所有权。

后续：[对话滚动引擎](../../implemented/architecture/2026-09-27-conversation-scroll-engine.zh.md)（#1071）取代了按 key 虚拟列表和 `useStickyScroll`。回复留白滚动由引擎的 `sent` 意图负责，待提交消息（`trailingContent`）渲染为引擎的固定 `trailing` 行。

资源层整合保留主线的目标同步与 workspace 销毁顺序。作用域所有权规则在不改变保证的前提下压缩，以满足 AGENTS.md 大小限制。

桌面整合先收尾 renderer，再进入现有 CLI 退出屏障；取消时服务不停止，CLI 停止失败仍保留所有权。恢复对话框使用当前 UI 组件。journal、queue-steer、writer 和会话动作共 91 项测试通过，退出顺序与取消测试通过。

Review 修正：普通消息进入历史后，即使旧历史或队列暂时阻止 RPC 快速投递，也会先持久化唤醒标记再同步。历史分类和执行顺序仍归 CLI 管理，旧的导入 `seen` 行不会再让空闲会话漏掉后续消息。Electron 发送注册属于具体渲染文档，不属于复用的 WebContents；确认进程退出或文档导航完成后结束旧请求，仅超时仍阻止退出，新产品文档需要重新注册。回归测试覆盖真实 Loro 历史、journal 落盘与 CLI 监听判断，以及原生事件到实际重载入口；尚未完成打包应用的崩溃注入验收。

图片回退修正：延后准备图片后仍保留原有同机 Electron 回退；云端图片上传失败时，使用 CLI 已有的本地文件回执，保存成功结果并保留消息其它内容，不引入新传输方式，也不禁用 backfill。远端目标、无本地能力、取消和已达到文件数量上限均禁止回退；本地交接也失败时保留最初的上传错误供重试。测试使用真实 journal 存储与 Loro 历史，验证最终文件块和失败时保留的完整消息。

## CI 测试生命周期

移动端 opened-by 列表测试在渲染、折叠交互和卸载时等待 React `act`，并仅在每个测试期间启用 act 环境。这样会在 jsdom 销毁前处理完 React 工作，不再依赖 `flushSync` 或固定延时；已有断言仍验证真实列表及共享折叠状态。此栈同时接入主分支的日志测试清理修复：等待文件 transport 的 finish 事件后再删除临时目录。这些修改只明确测试资源的归属，不改变附件或产品行为。
原生退出批准只在 runtime 清理后解除发送模块自己的 beforeunload 阻止，主进程不覆盖其它模块的卸载保护。编辑器未保存、保存中、冲突和失败状态与原生退出检查共用同步判断；存在任一状态时提示先保存并阻止清理，commit 再检查确认期间产生的编辑。普通关窗在 drain 后重新调用 close()，不使用 destroy()，保留原生卸载保护。检查失败时 runtime、CLI 和 relay 均保持可用；菜单/键盘重载仍共用守卫。测试挂载真实编辑器 hook 和恢复组件，覆盖退出/重载/关窗、保存失败和确认期间编辑，并验证 drain 后原生关窗保留其它 veto。

每个账号/工作区的恢复存储允许 100 条未完成消息，消息元数据与已准备 CRDT 操作共用 128 MiB 预算。附件源 Blob 沿用既有文件/图片大小与数量限制，并受浏览器实际 IndexedDB 配额约束；不占用元数据预算，也不额外降低单条消息上限。存储事务失败时保留输入框草稿。全部附件都有成功回执后，在同一次检查点持久化最终输入并释放源 Blob；仍有准备任务需要重试时保留源数据。

根据本窗口活跃任务以及同账号/工作区的 Web Locks（含等待锁的执行者）判断恢复状态，不持久化忙碌标志。启动、进入会话和回到前台时刷新，读取记录不会自动发送旧消息。桌面和移动端的中断消息行内提供“继续发送”；prepared 记录还提供带披露的丢弃入口，因为消息可能已经进入历史。不再有独立的工作区恢复面板；侧边栏行状态只负责把用户引回会话。

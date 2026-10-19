# 原生 Workspace Repo 所有权

Status: proposed
Translation: current
PR: [#1607](https://github.com/LodyAI/Lody/pull/1607)

[English](2026-10-16-native-workspace-repo.md)

## 摘要

用户要求在[正式依赖升级](../../implemented/architecture/2026-10-16-streams-repo-release-adoption.zh.md)的同一个 PR 中接入原生消费者。CLI、renderer、预取 worker 和私有快捷指令 room 使用已发布的 Repo/SDK；一个 workspace Repo 拥有副本，现有 Promise API 经过唯一的废弃 facade。审查发现局部释放失败会截断清理链，并留下无法从正常获取入口恢复的隔离状态；现改为继续独立清理，并在下次获取时重试保留的 owner。包括 host 存储迁移和上层 Session/Turn 工作在内的 [WorkspaceData 设计](2026-10-14-workspace-data-services.zh.md)仍是提案。

## 职责与行为

锁文件保留 main 新增 E2EE 包仍锁定的旧 Streams 依赖图：CRDT 0.17.0
依赖 Client 0.10.0，另有 Client 0.9.0 引用。升级时裁掉这些记录，会让 GitHub
自动合并结果出现悬空引用，即使 PR 分支本身能够安装。补回既有的完整性校验值与
snapshot，workspace catalog 仍选择 Client 0.12.0 和 CRDT 0.19.0。
应在合并结果上验证冻结安装；仅做 lockfile-only 解析无法发现这类缺失依赖图。
失败的 CI 合并树在修复前可复现缺失依赖，修复后完成了关闭生命周期脚本的离线冻结安装；
这验证依赖图闭合，不代表原生构建或完整测试套件通过。

- Workspace 在既有 SQLite 或 renderer IndexedDB 上拥有一个原生 Repo；消费者在子 Scope 中借用 Doc、Flock、room lease。打开缺失与创建业务身份不同；本地模式不请求云端。
- 原生 Streams transport 复用 token 服务和副本绑定 checkpoint；前台显式沿用同一存储的 Doc cursor，预取 worker 使用隔离副本和易失 cursor。peer baseline、服务端确认和本地持久化不能互相替代。
- CLI 目录读取和元数据确认在既有业务入口组合原生 Repo 操作，删除只有一个消费者的目录与权威对象、未使用的查询选项和兼容方法；保留身份规范化、删除过滤、排序与每次新的服务端确认。
- 本机 v7 客户端拥有 worker、期限和有界队列，含约 64 MiB 的字符串保留预算。分块输入必须完整且版本覆盖公告 frontier；普通写入不增加 join epoch。旧客户端仅作为测试 fixture 保留 host 协议兼容覆盖，没有产品导出或应用导入；原生客户端测试连接真实 v7 host。
- Legacy 房间投影包含实际路由与 attachment：缺席路由为 detached，即使新原生 detail ref 初始为 joining。首次同步等待跨越主动缺席，但实际已挂载路由失败会拒绝等待。
  房间句柄保留原生 RoomLease 及仍有消费者的 UI 状态视图；清单和 transport 快照直接读取原生 lease，本地房间记录只负责 purge 时释放借用 owner。删除未使用的聚合/等待结果 API 与平行 adapter/status 表。原生 sync／reconcile 重试失败的 attach 并保留 SDK producer，替代应用层逐房间 rejoin 任务；继续复刻完整旧订阅协议会重复这些 owner 和状态。

## 释放、恢复与因果交接

Session reader 先通过同一 Repo 等待 catalog 元数据，再选择后端。Runtime 退休会取消这些等待；
Session 退休和构造失败会先清理 reader 观察，再释放借用的 Doc。保留 main 的增量历史唤醒，
并同时保留本 PR 可重试的 native 清理路径。
恢复等待消费所选 native 房间的 baseline 状态，不使用上传回执。原生 observer 测试只模拟期限计时器，
保留 worker 调度。

上游副本释放在取消订阅前提交并保存文档和元数据。失败会保留 `RepoReleaseFailed.retry` 及已接受的 I/O；再次获取有可能必须先成功完成旧释放，才能构建副本。SDK close 停止网络准入并等待已接受的工作，不代表发起一次新的服务端上传确认；单纯离线不能证明快捷指令 close 必然失败。

Legacy Doc/Flock handle 将已有副本缓存的持有与每个视图的借用分开。Session、预览、schedule
cache、Code Collab 文件索引和快捷指令索引在驱逐或工作区关闭前释放各自借用。卸载先保存，再关闭缓存持有；普通配额故障使原副本保持
活跃和可借用，持续故障期间反复、并发重开仍使用同一副本。后来成功卸载才释放原副本并允许新一代。
真正的 native release 失败仍需先恢复，不能直接吞错：已安装 SDK 在最终释放开始时就标记 retiring，
再次 acquire 会要求完成旧释放。缓存持有属于 Legacy 已有的所有权，成功卸载或工作区关闭时释放，
没有增加后台重试循环或第二个 Repo。纯 native 借用仍按 Scope 释放。Flock 读者使用
`acquireFlockDocHandleLegacy`，最后一个视图释放不会在保存成功前退休缓存副本。驱逐失败仍
拒绝并保留原始错误，后续借用者仍可复用活跃副本。Code Collab 经 `unloadFlockDoc` 驱逐；
快捷指令索引同 Promise 基线一样，保留缓存持有至显式驱逐或 Repo 关闭。卸载警告不输出
原始错误、Cause 或用户正文。
Doc/Flock 卸载等待使用 SDK release 的期限，默认 30 秒；不会取消或重复已接受的 adapter 工作。
挂起保存可以超过等待期限，视图仍借用同一副本；后续持久化和关闭仍等待原写入。
CLI 重新初始化也将已释放的借用与卸载结果分开，保留同样的可用性。

关闭先结束借用者再关闭 Repo，但一个 store 失败不能跳过其他 store、transport 清理、join 收尾或 Repo 关闭。Runtime 尝试这些独立步骤后统一报告错误；再次 dispose 会重试保留的 owner，且不重新允许新工作。RuntimeProvider 按 workspace 保留可重试关闭；一个关闭失败不阻塞其他 workspace，重开同一存储前先重试旧 owner。快捷指令根按数据库执行相同约束；runtime、远端、index 或 store 的失败不会跳过其他清理及 Repo 关闭，已经 disposed 的 runtime 仍能重试未完成的退休。
Session 清理保留真正失败的 borrow release 重试 handle；借用一旦成功释放，卸载失败仍会报告，
但不能阻止在仍活跃的缓存 Doc 上重新初始化。后来成功卸载才使本机房间失效。manager 查找
会重建驱逐失败后保留的已销毁 Session 视图，不再返回其已释放的 Mirror／SessionData。
清理和重新初始化共用既有每 Doc 所有权链，并发打开加入同一次 pending 初始化。真正失败
的借用释放仍由原 wrapper 持有，重新初始化前重试。晚到的 join 检查捕获的 handle 身份，
不能替换恢复后生命周期的房间。
cache/shortcut 获取仍重试真正退休中的 owner；直接替换它可能遗留 SDK producer，原生 Repo 本身
也可能需要先完成旧释放。这项必要互斥不适用于保存失败后仍活跃的缓存副本。

后台 stream 失败只输出不带 payload 的诊断，不再无限保留历史 Cause，也不会让后来成功的 destroy 报失败。Scope finalizer 只运行一次；小型 ownership helper 保留原生 retry owner，而不是假装重新关闭失败 Scope 能重试。日志不包含私有 Cause 或 grant。

私有快捷指令的构造、connect 和 join finalizer 已共用 workspace owner Scope，但 SDK
退休失败的类型是 `DurableReleaseFailure`，不是 `RepoReleaseFailed`。把这项有类型的回执
当作未知 Cause，会在已接受的 HTTP 请求完成后仍永久重放旧失败。现有 Scope 恢复边界现在
调用真实的 `retryRelease`，与 Repo 回执一样在成功后清除保留的失败；其他未知失败仍然可见。
不增加第二个 SDK owner、不重放已关闭 Scope 的 finalizer、不丢弃写入，仍保留 producer
未完成时的依赖关闭顺序。

借用者 Scope 失败不能证明 Repo close 是独立步骤：私有 shortcut SDK producer 也在
consumer Scope 下，可能仍持有已接受的 I/O。因此保留依赖关闭顺序，不跨过任意失败强行关闭 native Repo。
其他工作区仍然独立；再次关闭先重试保留的 owner，再释放 Repo 和存储。
不增加全局 gate 或后台重试循环。
已安装 SDK 没有终止并丢弃未保存工作的接口。持续失败或挂起的原始 writer 仍需确认退休后，
才能对同一存储开启第二个 writer；本次修复不声称实现有界的有损终止。

CLI 与 renderer 在 transport 组合入口注册 SDK 快照诊断 observer。共享显式标量投影保留快照与请求关联、permission/auth/HEAD/export/encode/PUT 阶段、编码后正文长度、结果和单调时钟测得的阶段/工作流实际耗时。Native Repo 错误格式化同时保留 `abortKind`、`timeoutKind`、`uploadStage`，不转发私有 Cause、任意错误文本、正文、token、headers 或敏感 URL。普通 fetch 仍为 `total-only`：没有传输子阶段就保留未知，不把超时预算当作实际耗时。快照阶段使用 debug，失败使用 warn。保护内容已有 observer 继续组合，异步失败也隔离；日志或 observer 失败不改变上传、重试、授权及 local-only 组合。

配置保存保持本地优先。Writer 在提交本窗口编写的 Provider 行后记录待交接 token；只有该配置存在待交接写入时，probe 才等待指定本机 Machine Flock peer 的回执。没有待交接写入的启动、backstop、强制刷新不新增数据面依赖。确认只清除调用捕获的 token，不吞掉并发的新写入；未确认或超时返回失败响应并保留 token 供重试。取消或 dispose 阻止晚到回执启动进程；云 transport 和服务端权威不参与这次本机交接。

兼容层的写入屏障与连接撤销保留了 readiness 和已完成句柄表无法替代的两项保证。首次同步后再发生本地编辑，仍需要新的确认：`waitUntilSynced` 对 server 路由使用原生捕获版本的上传 ACK，对 peer 路由检查指定路由的协议回执。路由缺失、离线或不支持确认只使这次显式等待失败；首次同步 readiness 与本地优先写入不增加新门槛。即使借用者取消等待，有期限的上传 producer 仍由 native Repo 持有；取消不会退休其他借用者的副本。

Transport owner 在 adapter 构造或 native connect 前同步登记。移除会取消获取并关闭 owner Scope，由 native finalizer 撤销注册、等待已接受的连接工作。获取在 native 注册前与完成 lease 发布前均检查取消；移除与获取失败清理共享现有的串行 close，且仅当登记仍指向自身 owner 时删除。确认释放后才允许同名后继接入。关闭失败保留 native retry owner，下次同 id add 自动重试，兄弟 id 仍可用。生命周期原语是 Scope，登记表只持有 owner，不复制 native 状态。

本机 v7 拥塞恢复保留 1,024 个事件、默认 64 MiB 的队列上限。溢出只使该房间当前的屏障失败，包括已接受但尚未消费的 sync 事件。显式 reconnect 或物理连接 online 边会中断并等待旧消费者及其已接受的 Flock I/O，停止期限任务，再在同一个房间 Scope 中创建新队列和 worker。重置不完整分块、请求 id 和服务端 frontier 后，从保留的副本版本重新追赶。CRDT/lease 与状态引用不变，完成追赶才增加 epoch。等待被取消时移除自身回执，不退休共享副本。每个房间的原生 semaphore 将重启与 close 串行化，避免新消费者超越旧任务；关闭后不再准入恢复。这是局部生命周期边界，不是工作区 readiness 或写入 gate。各房间分别恢复，一个房间等待已接受的导入不延迟其他房间的追赶 worker。

物理连接状态分发也不能等待这项 drain。健康房间直接收到状态事件；溢出的 member 在
transport Scope 的 FiberMap 中按对象身份保留一个恢复任务。反复 online 边合并到现有修复，
任务完成即移出集合；房间原有 lifecycle 串行约束仍使 close 等待恢复。
显式 reconnect 仍等待退休完成；已退休 transport 忽略队列中晚到的状态边。

## Session 修复与剩余失败影响

房间 binding 的首次同步属性每次读取都等待当前 native 状态。协议首次失败仍使原调用方
的 Promise 永久拒绝，但不把失败缓存给后续读取。同一个 binding 恢复为 joined、baseline、
current 后，新等待和 RoomSyncTracker 恢复都能成功。关闭借用的信号仍取消等待者；不新增
期限、producer、重试循环或状态缓存。

Repo 0.23.0 提供所选房间的 sync／reconcile，没有单 binding reset。Session history 重试
因此仅执行现有房间的 `sync('streams')`，沿用 Doc 同步期限（默认 8 秒）和借用者信号。
offline／未确认结果使本次尝试失败，不算成功，也不再无限等待 readiness。原生 reconcile
可重试失败的 attach。在线 sweep 并行 sync／reconcile failed／offline 房间和 SDK 已确认
失败的初始化，等独立修复完成后汇总失败，不触碰健康房间、presence 或普通的 pending baseline。
这纠正了此前“集中到控制器就受退避控制”的表述：
健康时的 30s sweep 绕过了 backoff。持续的单房间 403 不得每个周期重置全部成员。整连接
自身处于 offline／closed／failed 时，server transport 才可重启全部成员。复核 `177e5bcb`
后纠正此前只保护周期 sweep 的遗漏：renderer 唤醒、online、auth 都传入 `resetBackoff: true`，
每次强制尝试仍会重置健康 SDK generation。在线 server transport 现在不论该标志都走
同一条所选房间修复路径。原生 Streams reset 在 join／create 共用的 admission permit 下串行
重启全部成员和 presence，避免调用它才能保护无关房间和新操作的准入。本地 peer 的强制
reconnect 保持原行为，因为溢出恢复必须 drain 失败的队列／worker，单独 `room.sync` 无法
重建它们。不新增状态、重试循环、期限或恢复 owner。

复核 `ebf906f9` 后纠正此前过宽的论断：不可重试 HTTP 错误不等于需要整连接 reset 的终止
generation。正式 CRDT 0.19.0 的 live 4xx 使用 SDK 自身封顶退避，默认无限重试；所选 sync
会重试失败的初始化，并重新执行 catch-up／append 屏障。但失败的初始化可能仍被 Repo 投影
为 joining，仅过滤 failed／offline 会永久漏掉它。facade 现在直接读取 joining 房间的原生
transport health，仅在初始化未 ready、有不可重试错误或首次同步总期限已结束、且无待完成的
SDK 已接受 I/O 时执行所选 sync。默认 120s 总期限会终止初始化，尽管 `initial_sync_timeout`
仍标为可重试；把它误当作活跃重试会导致服务恢复后房间仍卡住。其他可重试的初始化错误
继续由 SDK 重试循环持有。正常等待或退避中的 baseline 保持原 owner，不新增状态表或整连接
reset 冷却器。
SDK release receipt 与 HTTP 错误分类分开，仍由既有 retry owner 持有。没有单 binding reset
并不妨碍上述 HTTP 恢复。

CLI composition 没有可变的 transport 路由谓词，lazy acquire 会调和所选 target；未找到 CLI
依赖周期性 refresh 的调用。renderer 路由变更继续显式调用 `refreshTransportRoutes`。

触发者仍是控制器 watchdog 或已有 reconnect 请求。原生 Repo 持有所选房间的 reconcile／sync、
截止时间及已接受工作；facade 传递调用方取消信号，私下汇总独立失败的 Cause。不新增 owner
交接或保留任务表。失败修复继续可见、可重试，不中断其他房间的修复。

以下设计限制不在本次修复范围内，不能算作已满足失败隔离或终止关闭的保证：

| 触发 | 影响与保留 owner | 恢复／剩余限制 |
| --- | --- | --- |
| 私有快捷指令反复 `sync()` | 每次 connect 向房间 Scope 增加 SDK lease／finalizer，数量随调用增长，直到房间关闭 | 房间 dispose 会释放；每房间只 join 一次仍待后续处理，目前没有独立调用次数上限。 |
| borrower Scope 关闭失败 | destroy 在 native Repo close 前停止，未到达关闭房间与停止 autopersist 等后台步骤 | 保留的 workspace owner 重试关闭；其他工作区独立，但期间仍有后台活动。绕过依赖可能遗留仍持有已接受 I/O 的私有 SDK producer。 |
| workspace 退休时 IndexedDB 持续配额失败 | RuntimeProvider 的同工作区关闭门禁会在本窗口拒绝重开，每次重试还可能消耗释放期限 | 存储恢复后才可完成退休；尚未实现同 key 接管、有界终止关闭／用户报告及 SDK／原始 writer 终止合同。这仍是产品可用性限制。 |

## 验证与限制

readiness 和 Session 恢复在真实 Repo 边界验证。失败的 attach 在同一 binding 重试，观察
native joined／baseline／current 和恢复的 Doc 字节，再确认 UI tracker 回到 synced；原等待
仍以原错误拒绝。真实文件存储的保存被保持并失败时，manager 同 key 的并发 Session 打开
共享一次初始化，其他 Session 仍可用；反复失败和存储恢复后，原字节、Mirror、历史 writer
都能使用。旧 handle 晚到的 join 必须释放自身，不能替换新房间。组件五个套件 111 项通过；CLI 四个
套件 125 项通过，Roost active-goal 用例超时；Session 套件单独复跑 17 项也全部通过。
隔离的 `fd0f4ee8` 快照在接近 30s 用例期限时通过该 Roost 用例，当前版本最后一次隔离
复跑也在原期限内通过。此前并行和隔离运行的超时仍作为耗时相关的验证限制，不能称作
已知基线失败，也不能据此声称完整并行套件通过。该夹具手动组合 handle／控制面，不执行
本次改动路径。CLI controller 的 17 项（含正式 SDK 恢复）也通过。原 facade 的同 binding readiness 恢复用例失败，原 manager 的两个用例均返回
退休视图；仅移除 handle 身份检查，旧 join 就在两个用例中替换新房间。原等待／清理错误
仍然可观察。必需的根检查通过 Shared／components 类型后，在 CLI 类型阶段达到十分钟
预算（退出 124）；CLI 单独类型检查通过。改动文件的类型感知／Effect 检查、格式、文档和
八项边界／翻译检查通过，不声称完整根测试通过。

`fd0f4ee8` 的在线 server 修复使用真实 Repo lease 和注入的原生 transport 边界验证：Web 和 dual 的
visible-wake 路径保留健康 generation；双路由失败房间经过三个重连循环周期仍不干扰
兄弟房间，解除注入故障后会上传原 Doc 字节。detached 路由保持空闲。transport 本身
处于 offline／closed／failed、peer 强制重连、已接受 reconnect I/O 的 drain 和关闭也继续
覆盖。这些 renderer 夹具模拟 transport 边界，不是完整 Streams HTTP 协议；后者由既有
正式 SDK 的 CLI controller 用例覆盖。五个相关套件共 133 项通过：facade 32、runtime 64、
重连循环 8、本地 v7 12、CLI 恢复 17。visibility 用例等待真实 cloud reconnect 调用结束，
不依赖固定次数的微任务排空。`177e5bcb` 对照保留原 facade，四项强制修复回归均失败：
facade force、Web 唤醒、dual 唤醒和 dual 持续房间失败；非强制房间修复仍通过。
前一提交的 GitHub CI 和 Desktop E2E 通过。改动文件的类型感知 lint 与 Effect lint、全仓
格式、文档和八项边界／翻译检查通过。完整 Effect lint 尝试被 SIGTERM 终止；相关文件检查
通过，不能声称完整静态检查通过。Shared／components 类型检查通过；必需的根检查在
Electron web 类型检查阶段达到十分钟本地预算（退出 124），不报告完整根检查链通过。

Flock 复用用例在真实 IndexedDB 批量保存和文件存储保存边界注入故障。远端导入的索引在
持续故障期间反复释放、重新借用后仍为同一个 Flock，字节保留；其他 Flock/Doc 视图仍可
打开。存储恢复后可成功驱逐并从磁盘加载新副本。保持中的批量保存超过驱逐期限后仍由
原 owner 持有，另一个视图在同一 Flock 写入的字节也会在之后保存。这些用例覆盖 Code Collab
和快捷指令 runtime 消费者，而非只测试 facade。五个相关套件共 130 项通过。对照中仅移除
Flock 缓存持有，两个消费者的回归用例都因 `RepoReleaseFailed` 失败；快捷指令 runtime
在目录错误状态中暴露该失败。前一提交 `7d35b3ff` 的 GitHub CI 和 Desktop E2E 已通过，
这是本次 Flock 修改的基线，不代表新修改验收。Shared／components 类型、改动文件类型感知
lint、完整 Effect 检查、全仓格式、文档和八项边界／翻译检查通过。必需的根检查在 Electron web 类型检查阶段
达到十分钟本地预算（退出 124），不能声称完整通过。

六项真实 SDK 用例覆盖 bootstrap、live read、append、持续 bootstrap 403、保持中的正常初始化
及首次同步总期限已结束。临时失败后恢复到 synced，模拟服务端实际导入本地编写的 Doc 字节。持续拒绝的三个 watchdog 周期内，
失败的 SDK generation 被重试，本地字节保留，健康兄弟房间状态和真实 SDK generation 不变。
正常 baseline 在 watchdog 周期内保留已接受 I/O 和原 generation，释放后仍由原 generation 上传。
总期限用例持续返回 bootstrap 503，推进默认 120s 期限，断言已结束的可重试超时和无待完成
I/O，再恢复服务并观察原有字节上传、健康兄弟房间 generation 不变。它在 `84416154`
上经过三个 watchdog 周期后仍失败。
bootstrap 回归在 `ebf906f9` 上因没有编写字节到达服务端而失败，加入 health 判断后通过。
`7d35b3ff` 的总期限修复通过五个相关 CLI／renderer 套件 127 项、全仓类型、完整类型感知 lint 与 Effect、
格式、文档和八项边界／翻译检查；脚本 58 项通过。SDK 退避使用 TestClock，控制器 interval
用假时钟。这里使用正式 SDK／Repo
和模拟 HTTP 边界，控制器 Meta 状态为注入值，不代表线上服务验收。
必需的根检查在完整 CLI／renderer 测试阶段达到十五分钟预算（退出 124），不声称完整通过。
运行中出现此前已复现的 SSH 凭据 fixture 失败及 UI／Roost 超时。三个未改动 UI 套件串行
复跑 95 项全部通过。独立 Roost active-goal 用例在本次版本仍超时，而 `84416154` 快照
接近既有 30s 期限通过；该耗时失败的原因尚未确定，不能报告为通过。

在 `ebf906f9`，watchdog 回归在 `c57f9ec8` 观察到健康兄弟房间变为 `offline` 而失败，缩小 facade 修复
范围后同一个真实 Repo／控制器夹具通过。三个假 interval 周期中，持续权限失败保持可见，
另一处离线房间反复同步并写入 Doc 字节，健康房间状态和实际 presence 发布持续可用。
连接本身 offline／closed／failed 以及 peer 强制重连用例仍重置连接并保留原副本。五个相关
CLI／renderer 套件通过 121 项。全仓类型与类型感知 lint、完整 Effect、八项边界／
翻译检查、格式和文档检查通过。这是注入原生 transport 边界的验证，不是线上权限服务测试。
根检查通过类型、lint 和 Effect 后，在沙箱内未修改的 `effect-lint.test.mjs` 嵌套进程
夹具处停止；全部脚本 58 项移出沙箱后通过。未进入完整应用测试阶段，不声称当时根检查全绿。

Session 隔离回归在 `11f89018` 明确观察到健康兄弟房间为 `offline` 而失败，改为所选房间
操作后通过。真实 Repo 配合注入的 transport，用显式门闸控制整连接 reset，并核对两个
pending Session 实际导入的 Doc 字节。joining／offline 的假时钟用例验证等待超时后仍可
重试，另一借用者仍可用；取消覆盖原生 reconcile 和 sync 两个阶段。含既有 SDK checkpoint、
dispatch／recovery 覆盖的四组 CLI 套件在 `c57f9ec8` 共 90 项通过。
该修订的 CLI 类型、修改文件 lint、Effect 与边界检查通过；当时的根检查在组件类型检查
阶段达到本地十分钟预算，不算完整根检查通过。

在 `6c5fca07`，提供的两项深审复现失败，原有 19 项通过。修复后扩展套件 22 项通过。
真实 SDK HTTP 在 connect/sync 和 join 两条路径中被保持到 abort 和释放预算之后；请求完成后，
Scope 退休与同一数据库重开成功。另一个用例保持真实 Flock import 并使 Meta 溢出，兄弟房间
仍处理后续反复 offline/online；释放 import 后在同一 Meta 副本上恢复，disconnect 后再到达
online 仍保持 closed。这些是注入边界，不代表生产网络验收。

`6c5fca07` 的 CI CLI 分组还发现 main 新增的三项 Role 历史测试仍为迁移后的
SessionDocument 构造旧 Promise Repo。夹具现改用消费者实际使用的 WorkspaceRepoLegacy，
提案持久化、幂等性和权限断言保持不变。

`11f89018` 通过完整 Shared 1,543 项、受影响 renderer 93 项、Role 历史四项，以及全仓类型／
静态检查、脚本 58 项、格式、文档与边界检查。本地根检查在类型、lint 和脚本通过后，
于完整 CLI／组件测试阶段停止，不能算作全套通过；仍需最终合并结果上的 CI。

真实 IndexedDB 持续保存失败的回归在 `c2dc8435` 失败、修复后通过。它验证反复及并发重开、
原 Doc 身份与字节、兄弟文档独立写入和持久化、后来成功卸载和新一代副本。
另一个真实 Scope/IndexedDB 用例保护关闭失败的私有 SDK producer 的存储，验证另一个工作区
仍可持久化，并在恢复后关闭 producer 和存储。
真实 renderer 预览入口和 CLI Session 重新初始化也验证了持续故障期间复用原副本，
无需等存储恢复才能重开视图。
假时钟用例将真实 adapter 保存保持到卸载期限之后，在原写入仍被持有时重开同一 Doc，
最后完成写入并核对磁盘字节。超时不会变成持久化确认。
整合 main `7246f783` 后，验证覆盖受影响 renderer 143 项、含 daemon/MCP 的 CLI 175 项，
以及 Shared 协议/快捷指令/锁 48 项。整合前 Shared 全量 1,521 项通过。
受影响包的类型、修改文件 lint、格式、native 边界和文档检查通过；真实进程/IPC 与依赖 Git
的检查在限制性沙箱外执行。没有从头完整跑完本地 root 测试链；这些结果不替代最终 PR 合并结果上的 CI。
RuntimeProvider 保留 main 的有界客户端日志事件，只记录 operation/error type，不传入私有 Repo 错误。

真实 v7 host 测试分别在默认事件数上限、默认字节预算和注入的小字节预算下连续触发两次拥塞。经过 schema 校验的消息突发包含真实 Loro update 字节，当前等待会失败，独立房间仍可同步，随后原 Doc/Meta 副本恢复上下行写入。另用显式 gate 阻塞真实 Meta import，证明恢复会先等待已接受的不可中断 I/O，再替换消费者；期间兄弟房间仍能完成追赶 epoch。所属原生套件 11 项通过。本次修复的 Shared 全量 1,522 项、受影响 renderer 四组套件 89 项通过。在独立的 `a2f0911d` 工作树上，新增五项拥塞回归针对修复前实现均失败。根检查另有未改动的 SubagentTaskPanel 命令详情用例超时，所属套件单独复跑 19 项全部通过；将此结果与已知 SSH 凭据 fixture 失败分别记录，不把根检查报告为全绿。

真实 renderer SDK fixture 覆盖明文/保护快照成功、PUT 阻塞期间注入的 275 ms 实际耗时，以及经过 native Repo 错误格式化的 60 s 总上传超时。日志 sink 与异步 observer 抛错都不会使上传失败，也不会跳过已有 observer。CLI SQLite/SDK fixture 校验阶段记录，并将编码后字节数、request id 与真实 PUT 关联。投影排除诊断 DTO 中额外添加的私有字段，真实失败路径中的合成私有 payload 与 Cause 同样不进入日志；传输信息只记录 SDK 实际提供的证据。移除 observer 注册与三项错误分类后，回归 fixture 失败。

在 `a2f0911d`，诊断修订通过受影响组件 63 项与 CLI 专项 5 项，以及完整 workspace 类型/静态、格式、文档和边界检查。CLI 全量为 4,313 项通过、1 项跳过，另有此前已复现的 SSH `context_unreadable` fixture 失败，因此根 `pnpm check` 仍未全绿，也没有通过该命令跑完所有包的完整套件。脚本套件 58 项全部通过。

回归 fixture 使用真实 SDK，在 baseline 后阻塞上传 POST；另以显式连接暂停驱动真实 Streams transport。断言服务端收到的字节、native 清单移除与同 id 重连；其他 native 边界用例覆盖构造/connect 中取消、晚到完成与后继隔离、释放重试及未确认 peer 回执。这些是合成 HTTP fixture，不代表生产网络验收。

恢复 `d82fea54` 的 facade 后，两项真实回归 fixture 均失败。在 `95ee59f7`，根检查在沙箱内的脚本 fixture 停止，同一完整脚本套件在沙箱外通过；受影响的 CLI 套件与完整 Shared 套件也在沙箱外通过。

行为回归覆盖 cache/shortcut 释放失败后的自动恢复、共享副本、保存失败后原始字节保留、后台 observer 失败后正常关闭、workspace 清理的继续与重试、Session 释放失败后的本机房间失效，以及仅对待交接配置生效的 probe、取消和 dispose。原生 v7 host、旧 peer 兼容、快照与 Streams 套件分别保留协议覆盖；最终检查结果记录在 PR。
真实 native 集成还覆盖失败 attach 的重试、仅由 native 借用的房间清单、反复服务端确认与本地权威，以及原有四组晚到 reconnect 成功/失败和 waiter 重试下的关闭场景。waiter 超时后仍共享保留中的 native producer，新的触发边不会重复启动它。
Session 在 reconnect/readiness 阶段退休时，只取消自身借用的等待；持有同一房间和文档的另一个借用者仍然可用。

`df7de23d` 的完整 GitHub CI 和 Desktop E2E 通过；这是本次修订的基线，不是新修订的验收。未改动 SSH 凭据 fixture 的 `context_unreadable` 在精简前后均可于本地复现，因此不将本地 CLI 全量测试报告为全绿。本地测试不代表真实生产服务、浏览器进程崩溃或跨平台验收。Host 本机 server 所有权、SessionDocument wrapper cache、Session/Turn/dispatch、快捷指令 grant/发布、RPC、迁移 target 上传仍保留既有应用生命周期。PR 维持用户要求的同一接入单元；删除无消费者框架和产品重复实现，不再扩大迁移，也不修改尚在提案中的 WorkspaceData 设计。

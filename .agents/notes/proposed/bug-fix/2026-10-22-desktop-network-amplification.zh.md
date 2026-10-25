# 桌面端流量放大：快照传输与断线重连的边界

Status: proposed
Translation: current

[English](2026-10-22-desktop-network-amplification.md)

## 摘要

源码分析确认了快照传输放大，以及一条空闲恢复循环：缺少依赖的数据位于 bootstrap 首分页之后时，会绕过重试等待、反复下载完整快照。这些机制都用锁定版本做了合成复现，但不能直接解释某位用户的一夜流量总数。普通网络重连会保留读取位置，空闲预取在没有新事件时也不会自行重试。Lody 默认阻止应用自动挂起，且不以有任务为条件，因此熄屏不代表同步停止。应先归因实际请求或响应字节再决定修复；本次没有修改产品行为。

## 范围与证据

检查版本为 Lody `57bb469c2a31d43b4e9c830017504bc498ee2b5e`、`loro-repo` 0.23.3、`streams-crdt` 0.19.1、`streams-client` 0.12.1，以及真实 Loro 1.16.3。下载的 npm 包 SHA-512 与调查时 checkout 的锁文件一致。实验使用合成内容、内存中的 HTTP 边界和明确的完成信号，没有测量用户网络或已部署服务。用户安装版本、上传下载比例和统计工具范围仍未知。

## 完整快照上传的放大

[`createCliStreamsTransport`](../../../../apps/cli/src/lib/loro/streams-transport.ts) 开启快照上传，设置五秒防抖。明文前台 renderer transport 也允许上传。锁定 SDK 的 `transport-snapshot.ts` 和 `transport-internal.ts` 比较当前流末尾位置与远端快照位置，默认差值门槛只有 100 KiB。通过门槛后，导出整份文档快照，压缩后 PUT 上传。这个绝对增量门槛没有随已有快照大小增长。

定时器只在本地增量成功追加后调度，单纯接收远端数据不会调度。连续追加会重置防抖；位置不变或增量不足门槛时不上传。上传前还会检查远端快照位置，观察到其他写者也可能抑制上传。因此不能描述成无条件每五秒上传一次。

确定性实验直接调用复制出来的原 SDK manager，使用真实 Loro 与包内 zstd，仅替换 HEAD/PUT 和防抖等待。八次各 128 KiB 合成写入产生 1,049,574 字节的带帧增量，却产生八次完整压缩快照，请求体合计 115,431,823 字节。初始快照原始大小为 16,777,540 字节，压缩后为 13,938,153 字节。没有增量、增量不足 100 KiB，以及上传后位置未变，均不触发上传。这些是合成数据的编码和请求体实测，不是线上网络流量或实际上传频率。

另一组手动时钟实验验证了防抖重置、空闲不周期上传、远端版本变化后抑制上传，以及相同版本的自身回声不抑制。阈值计算包含远端快照之后所有流尾部字节，但只有本地成功追加才调度定时器。

仅用于说明量级：每 36 秒成功传输一次 100 MB 完整快照，八小时合计 80 GB。实际计算必须使用压缩后的请求或响应大小，不能使用文档内存或未压缩快照大小。

## 临时云端预取重复下载初始快照

[`runEagerSyncWorkerTask`](../../../../packages/components/src/providers/eager-sync-worker-task.ts) 先导入自己的快照缓存，再创建没有对应远端 cursor 的全新云 transport。SDK 创建空的 cursor store 后仍会重新 bootstrap；已缓存文档的版本不会让这次请求变成增量。真实 adapter 的合成实验初始有 50,000 个字符，后两轮各只新增一个字符。三轮都请求 `/bootstrap` 并接收完整快照，即使后两轮副本已持有上一轮状态。

这个结论只适用于云端 Worker 路径。双通道桌面端对本机会话的预取走本地 transport，远端机器会话走云端；纯云模式的桌面端则全部走云端。自动候选限制为 20 个，串行执行，并跳过已加入、已有前台资源或活动检查点已覆盖的会话。侧栏、可见性和离线状态会暂停工作。需要新的活动或其他符合条件的调度事件；15 秒新鲜度不是无条件轮询周期。

大文档还有一条额外失败路径。[`writeEagerSyncSnapshot`](../../../../packages/components/src/providers/eager-sync-snapshot-cache.ts)拒绝超过 128 MiB 的原始 Loro 快照。Worker 随后返回 `skipped`，而 [`background-sync-coordinator.ts`](../../../../packages/components/src/providers/background-sync-coordinator.ts)只有收到 `synced` 才记录完成的活动检查点。任何会话的 metadata 事件都会重建候选列表，因此其他会话的 metadata 变化也能重新排入同一个超大文档，即使大会话自己的活动时间未变。确定性协调器实验固定两个会话的时间、让预取返回 `skipped`，在启动及两次其他会话 metadata 事件后，观察到大会话被预取三次。这不是一次完整的超大云文档下载实验：证据分别是源码中的缓存拒绝、真实 adapter 的重复 bootstrap，以及协调器的调度实验。128 MiB 缓存门槛指原始文档编码，不是压缩后的网络大小。

[串行 Worker 决策](../../implemented/architecture/2026-09-12-session-prefetch-worker.zh.md)明确避免共享前台 cursor，[候选窗口限制](../../implemented/architecture/2026-09-16-bounded-session-prefetch-window.zh.md)约束预取范围。后续优化必须将 Worker 自己的快照与对应 cursor 一起保存；直接复制其他副本的 cursor 会跳过缺失数据。

## 连接错误与流量是不同证据

Chromium 将 `ERR_CONNECTION_CLOSED` 定义为 TCP FIN，将 `ERR_PROXY_CONNECTION_FAILED` 定义为解析或连接代理本身失败，明确不包括 HTTP CONNECT 阶段失败。参见 [Chromium 错误定义](https://chromium.googlesource.com/chromium/src/+/main/net/base/net_error_list.h)。API、presence、control 多类流一起失败，支持优先检查共用代理路径；它不能定位此前是谁关闭连接，也不能证明反复传输了大数据。

锁定 SDK 的同房间 `rejoin()` 保留 cursor，普通 live read 失败会退避。合成实验先从 100000 完成 bootstrap，再将 100123 写入注入的内存 cursor store，随后注入网络失败。下一次 SSE 从 100123 读取，bootstrap 总数仍为一次；实验没有验证磁盘持久化。缺少 cursor、服务端返回 410、恢复未完整导入等是另外的 bootstrap 路径。历史上的 [read-loop spin](2026-10-19-streams-read-loop-spin.zh.md)可能不再发出请求，不能用它解释大流量。

renderer 的 Chromium 网络与 daemon 的 Node 网络也分别管理代理。[`system-proxy-env.ts`](../../../../apps/electron/src/main/services/system-proxy-env.ts) 在启动子进程时，从 Chromium 解析出的系统代理补齐缺失的代理环境变量，已有环境变量优先。子进程环境是启动时的快照，而 renderer 使用 Chromium 的代理配置；关闭环境补齐并不会关闭 renderer 代理。

## 空闲与休眠边界

[`CliService`](../../../../apps/electron/src/main/services/cli-service.ts) 默认 `preventSleepEnabled=true`，存在持久化设置时采用该设置，启动 `prevent-app-suspension` 时不检查是否有任务或 Agent 在运行。[Electron 文档](https://www.electronjs.org/docs/latest/api/power-save-blocker)说明该模式保持系统活跃，但允许屏幕关闭。[`desktop-log.ts`](../../../../apps/electron/src/main/desktop-log.ts) 仅记录 suspend/resume，没有暂停 Streams 或刷新代理。renderer 依靠可见性、online 事件及 60 秒健康检查恢复连接；这些信号不能证明远端服务或选中的代理可达。

预取协调器在 `skipped` 后没有自行重试。手动时钟实验确认该结果后没有残留计时器，持续空闲不重试，从隐藏恢复到可见时才重新评估一次。真实 Repo/Flock 实验还确认：同值 metadata 写入不发事件，其他会话真实的 PR 或已读变化可以让被跳过的文档再次入队。Presence 心跳走独立临时通道，结果没变化的 PR 轮询也不写 metadata。因此，没有任务会削弱反复上传的解释；普通空闲轮询本身不能证明反复全量预取。

## 空闲时的不完整导入恢复会绕过退避

精确 `streams-crdt` 0.19.1 的 `recoverLiveIncompleteRemoteApply` 调用 `bootstrapState`。如果 bootstrap 只包含部分尾部数据，会继续调用 `catchupOrGone`；如果后续读到末尾仍缺少 CRDT 依赖，又会调用 `bootstrapState`。重试一直停留在同一次恢复调用内部，没有到达外层的退避等待。SSE 无活动定时器在进入错误处理时、开始恢复之前已经清除。单个请求成功也不会约束整次递归恢复的持续时间。

有界实验使用真实 SDK 读循环、真实 Loro adapter、包内 zstd，注入已加入的只读状态和合成客户端响应。模拟服务故意省略一个前置操作，并将依赖它的 update 放在 bootstrap 首分页之后。在零本地追加的情况下，连续返回三份相同的 3,485,325 字节压缩快照，合计 10,455,975 字节，没有保存 cursor，也没有退避计时器；第 4 次由实验停止。对照把同一坏尾部直接放入完整 bootstrap：只读取一份快照，随后安排退避。这个实验验证 SDK 恢复算法，不验证真实 HTTP、桌面休眠或生产流损坏。

分页 bootstrap 是服务端支持的行为，不是虚构响应格式。检查的[服务端 `470ce12`](https://github.com/loro-dev/loro-streams/blob/470ce12d9c7e734e2c42cef11a3e93438c4b0c22/rr/src/protocol.rs#L4187) 限制尾部增量分页，默认预算 64 MiB，快照另行流式返回。[协议](https://github.com/loro-dev/loro-streams/blob/470ce12d9c7e734e2c42cef11a3e93438c4b0c22/specs/ds-extensions.md#L377)要求部分 bootstrap 之后用普通 GET 续读。实验缩小了合成分页；按检查到的默认值，坏尾部必须位于较大的首分页之外。实际部署版本、配置，以及用户是否缺少这些依赖仍未确认。

另一处独立缺口是：当前 cursor 仍等于请求 offset 时，`resolveNextOffsetAfterConcurrentAdvance` 会接受响应中倒退的 offset。真实 SDK 的合成 SSE 实验交替返回 offset=0 的空 control 和已有增量，六次读取重复接收 786,729 字节带帧数据，没有本地写入，文档也没有增长。它要求远端响应给出落后的 offset；没有证据表明用户的服务端或代理确实这样做。休眠本身不能直接推出此条件。

## 建议的防护与现有日志

### 将导入后等待依赖的更新单独持久化

进一步源码检查和真实 Loro 1.16.3 实验确认了另一处持久化缺口：普通 snapshot 和全历史 update 导出不包含因缺少因果依赖而停放的远端更新。已有 `base|` 文档先收到 B、缺少前驱 A 时，B 进入 pending；不重启，补 A 后得到 `base|AB`；仅恢复普通 snapshot 再补 A，只得到 `base|A`；恢复 snapshot 并重新导入另存的 B 原始二进制后，再补 A，则得到 `base|AB`。这里指导入远端后的 pending，不是本地未提交事务。

独立 [Loro 实现](https://github.com/loro-dev/loro/pull/1220)已随 Rust 与 `loro-crdt` 1.17.0（`loro.js` 0.4.0）发布，并保留此前正式版的核心修复。它提供 `exportPendingUpdates(): Uint8Array | undefined`，以及 Rust `export_pending_updates() -> Result<Option<Vec<u8>>, LoroEncodeError>`，用现有 updates 格式重新编码解码后的 pending changes。空结果返回 undefined/None；非空二进制通过普通 `import` 恢复。导出不消费 pending、不提交本地编辑、不推进已应用版本、不发事件。测试覆盖已应用前缀、多 peer、Lamport、重复、交叠和 counter 缺口。[FFI #17](https://github.com/loro-dev/loro-ffi/pull/17)已合并并使用正式 Rust 依赖，真实 Swift/Python 恢复及类型化错误测试通过；这不代表对应 FFI 发行包已发布。Rustdoc、JSDoc 和已合并的[官网文档](https://github.com/loro-dev/loro-docs/pull/54)说明了一致检查点及其限制。

后续的 [Lody 接入](../../implemented/bug-fix/2026-10-22-loro-pending-persistence.zh.md)使用 Loro 1.17.0 与 LoroRepo 0.24.0，在现有存储日志中保留收到的 pending 输入，包含 Promise 文档路径。只有对应的已应用数据与 pending 都可恢复后，才能保存表示“已收到字节已落盘”的检查点；它必须与已应用版本、完整性状态区分，不能据此发布完整远端快照或压缩日志。导出错误必须保留上一份可恢复检查点，持续错误需要明确诊断。Streams 0.19.1 仍在导入不完整时不保存持久 cursor，因此单凭原始导出缺口不能证明该用户丢过数据。存储接入没有修好 SDK 恢复递归，也没有增加下载限额。如果远端前驱永久缺失，仍需要补回真实数据或提供可用新快照。

建议在 SDK 做两层防护：bootstrap 自己的后续分页再次遇到不完整导入时，禁止再次进入 bootstrap；同时限制每个房间完整恢复的次数和累计下载字节。快照、尾部位置和缺失依赖都没变化时，不应无限重复全量读取。只增加 30 秒等待仍不足以限制大快照的总流量。保留本地文档、pending imports、未上传修改和安全 cursor，只隔离受影响的房间。即使快照没更新，远端尾部也可能补齐缺失前驱，因此可通过低成本的检查点观察，允许预算内的新尝试。唤醒、token 刷新和重连本身不能重置预算。耗尽后需要明确状态及恢复入口；预算策略仍是提议，尚未实现。

本次选定的次数方案是：**同一次未解决的缺依赖故障，最多额外做一次完整恢复**，不是只允许一次 HTTP 请求，也不是每次重连各允许一次。正常的后续分页属于这同一次恢复。当前外层网络策略默认无限次尝试、等待上限约 30 秒；内部 bootstrap 递归则没有次数计数。新的故障额度必须跨内部自重启、rejoin，以及同一 runtime 中的房间 session 重建保留。仅抛出终态错误也不够，因为当前读循环会自行重启。只有缺依赖真正补齐、完成安全 catch-up 后自动恢复额度，或者通过明确修复/重试操作授予新的一次机会；远端 offset 变化本身不证明已修复。如果要保证重启应用后也不再重下，还需要持久化故障标记，这是独立的存储选择。用户认可一次恢复的方向，尚未实施代码修改。

验收应统计八小时假时钟下的合成传输字节，保留正常跨分页收敛，验证缺失前驱补来或新快照出现后可恢复，保证 cursor 不越过未完整数据，并保证其他房间继续工作。现有实验直接注入已加入的房间，不证明首次 join 缺少硬超时。

现有日志能记录最初的 SSE 失败，但不是下载账单。SDK 会输出 `sse flush chain error`，包含 `CRDT apply incomplete` / `missing deps`。[`installStreamsDiagnostics`](../../../../apps/cli/src/lib/loro/doc.ts) 将 CLI 的 `[streams-crdt]` console error 写入文件，前缀为 `[loro-streams-diag]`，文件默认保留 debug。递归的 `bootstrapState` / `catchupOrGone` 没有逐次成功下载日志。只有整个恢复返回错误后才输出 `live incomplete apply recovery failed`；long-poll 路径也可能没有最初的 SSE 错误就进入递归。因此，没搜到这些词不能排除循环，搜到一条不完整导入也不能证明反复下载或流量大小。打开 trace 不会补出原本不存在的请求或字节诊断。

云桌面 Nightly 与 CLI 共用数据根，默认主日志为 `~/.lody/logs/`，Windows 为 `%USERPROFILE%\.lody\logs`，可由 `LODY_DATA_DIR` 覆盖。按日期命名 `YYYY-MM-DD.log`，约 20 MB 轮转、保留七天，包含压缩轮转文件。桌面日志记录构建、通道及电源 `suspend` / `resume`。应用内 Help → Report bug → 选择机器 → Share logs 会收集今天和昨天，但每天只取末尾 4 MiB，较早事件可能需要对应轮转文件。以上是当前源码结论，仍需核对用户完整 Nightly 构建号及内置 SDK。

## 调查决策与限制

优先按方法和路径统计传输体大小：snapshot PUT/POST 看请求体，bootstrap GET、live read 看响应体，并覆盖其他域名；仅记录流标识、offset、恢复次数、重连数、字节总数和明确的预算停止原因，不记录 token 或文档内容。区分上传与下载、外网接口与 loopback。控制台错误条数既没有字节数，也没有重试时间。现有常规诊断保留警告和错误，并不构成完整的流量账单。

自动更新按固定间隔检查，托管 runtime 复用已安装版本、合并同版本下载，本次没有发现应用自己快速循环下载。隐藏的公共浏览器 view 仍然存活，因此网页媒体和请求是另一条有条件的候选。本地预览 HTTP/WebSocket 也可能进入某些进程统计。这些都没有被确认为用户流量来源。

候选修复仍是提议：限制不完整导入的恢复次数并进入退避、拒绝 cursor 倒退、依据快照大小设置增量门槛或最短上传间隔、为预取副本保存配套检查点，以及限制超大或无法写入缓存的文档再次进入候选的频率。不能把跳过的下载标成已持久化或已同步。提高门槛会减少上传但增加尾部重放，取消预取会减少流量但增加冷打开等待。应先归因实际字节；空闲报告优先检查反复 bootstrap/续读和 `apply_incomplete` 证据。本次没有产品修复、生产抓包、部署或全量应用检查。

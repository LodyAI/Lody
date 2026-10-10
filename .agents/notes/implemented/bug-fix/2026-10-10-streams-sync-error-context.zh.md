# 保留 Streams 同步失败的安全上下文

Status: implemented
Translation: current

[English](2026-10-10-streams-sync-error-context.md)

## 摘要

`Streams sync failed: internal_error` 丢失了区分请求失败、本地存储故障和 CRDT 故障所需的证据。对旧发布包的调查复现了这些情况，上游修改随后引入了安全的来源契约。Lody 现使用 Repo 0.21.2、Streams CRDT 0.16.2 和 Client 0.9.0，将该契约投影为本地诊断，并在调用方包装和同步报告中格式化失败。投影保留明确的重试属性，不记录原始异常或 provider 内部信息。合成验证证明信息能够传播，不能认定原始生产事故的原因。

## 原始调查

原 checkout 锁定 Repo 0.21.1、CRDT 0.16.1 和 Client 0.8.0。对这些精确 npm 导出执行的十个确定性检查确认了以下边界：

1. Client 归类已识别的超时/协议异常，并全局将 TypeError 当作网络失败。普通 Error 变为 unknown；这一层仍保留 cause。
2. CRDT sync 捕获上传、游标、bootstrap/catch-up、CRDT 和 durability 异常。普通 Error 变为 internal_error 且 retryable false；TypeError 变为 network_error。转换丢失普通 cause 和 errno，因此自定义 fetch 抛出 Error 时可能与本地游标故障完全相同。
3. Repo 的 fromStreamsError 简化为 `Streams sync failed: <code>`，丢掉状态、request ID、超时和来源。粗粒度 internal 分类还涵盖 server_error 与 initial_sync_timeout；默认重试属性可能覆盖底层 false。
4. 单 transport Repo sync 重新抛出该错误；多 transport 全失败时包装为 RepoSyncError.report。后续 Lody 包装无法恢复丢失的证据。仅接入旧版 diagnostics 回调不足以解决问题。

游标存储在 fetch 前抛出异常，可在没有网络请求的情况下复现事故文案。HTTP 503 和初始同步截止 fixture 复现了另外的信息丢失。[序列化修复](2026-09-29-streams-sync-serialization.zh.md) 记录了另一条历史上的本地 internal_error 路径；这些都不能证明原始事故的根因。

## 决策与归属

Streams 现于实际 fetch、HTTP、deadline、游标、CRDT 和 durability 边界记录来源。Repo 保留原始 discriminator、经过验证的 context、故障类别和明确的重试属性。审查后的 [Repo PR #144](https://github.com/loro-dev/loro-repo/pull/144) 合入为 `e99f17b`；[0.21.2 发布](https://github.com/loro-dev/loro-repo/releases/tag/loro-repo-v0.21.2) 已通过官方 registry 安装和 32 项公共 API 测试。Streams [CRDT 0.16.2](https://github.com/loro-dev/loro-streams/releases/tag/streams-crdt-v0.16.2) 精确依赖 [Client 0.9.0](https://github.com/loro-dev/loro-streams/releases/tag/streams-client-v0.9.0)。

Lody 的共享工具显式选择契约内的标量字段。CLI transport 创建将 warn/error 事件写入现有 logger；renderer 组合写入 console。CLI、room 等待、工作区 runtime 和会话错误详情使用同一投影。普通错误保留原格式，正常成功同步保持安静。有限深度的 cause 遍历处理包装与循环，报告保留注册的 transport 身份。

工具绑定到各调用方自己的 Repo 错误构造器。独立 pnpm 安装中，CLI 的 SQLite 13 peer 与共享包/renderer 的 SQLite 12 peer 解析为不同 Repo 实例，错误类身份不相等。默认使用共享包的 instanceof 会静默漏掉 CLI 失败。注入构造器可保留类型识别，避免接受任意对象或按消息猜测。

CLI Streams 组合在模块初始化时显式向通用错误工具注册这个绑定后的 formatter。直接从通用工具导入 Repo 会让没有 WASM loader 的独立 process-worker 打包引入 Flock WASM。将运行时绑定留在组合位置可避免该依赖，普通 worker 错误继续使用原有格式化路径。

安全详情包括 code、故障类别、retryability、room/transport、source、operation/stage、请求操作、超时 phase/预算/耗时、HTTP status、受约束 request ID，以及上游提供的白名单 errno；不含任意 message、stack、cause、body、headers、provider、token、key 或 URL query。包装消息可能含旧负载，因此不重新输出。网络证据只描述为请求失败，不宣称设备断网或后端宕机；HTTP 错误描述为响应错误。

catalog/lockfile 使用正式版本并删除过时的 Repo peer 例外。无关依赖保持锁定，包括 Roost 单独传递依赖的 Client 0.8.0。local-only 组合和禁用遥测约束保持不变；诊断 helper 不执行 I/O，也不影响重试策略。

## 验证与限制

- 旧包调查：10 项确定性行为检查通过。
- 新 Lody 接入：共享故障 fixture、真实 CLI SQLite 组合、renderer IndexedDB 组合和 room 等待共 24 项测试通过，其中 11 项为新增。故障使用合成消息/域名、注入 fetch 和假计时器，没有真实联网或 sleep。
- 正式版本已在独立 clone 中通过冻结 lockfile 安装；没有在嵌套 checkout 内安装。
- 保留真实 Repo 错误导出的 fixture 使 61 项既有 manager/runtime/provider 回归测试通过。Streams RPC：124 项通过、3 项既有集成跳过；共享包：1,380 项通过；Electron：214 项通过。
- 完整类型检查、类型相关静态分析（0 错误）、国际化及全部边界检查通过。CLI 生产打包、发布包 adapter/worker smoke 检查、WASM 复制和要求的格式化通过。
- 全量测试发现既有 Roost signed-prefix 超时及九项 Git/simulator fixture 失败；这十项均在未修改源码和原始发布依赖上复现。两项本次引入的收集/构建失败已通过保留真实 fixture 导出、将 formatter 绑定移出通用 worker 工具修正。最终 CLI 子集 22 项测试通过；worker 和 owner bundle 可在没有 WASM loader 时编译。原生 cloudflared IPC 执行受限于未修改基线也复现的超时，不声称 IPC 执行成功。
- 文档检查仍有此 checkout 未初始化 ACP 子模块造成的 74 个既有链接错误；本 note 及新 Spec 没有链接错误或受保护内容变化。

没有收集生产日志、凭据、对话实录或事故根因证据。未声称执行桌面/浏览器或已部署服务验证。意图仍为 [draft Spec](../../../../specs/streams-sync-diagnostics.zh.md)，实现不表示它已获批准。

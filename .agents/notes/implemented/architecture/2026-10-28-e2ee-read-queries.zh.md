# 加密机器只读查询

Status: implemented
Translation: current

[English](2026-10-28-e2ee-read-queries.md)

## 摘要

加密工作区原先在普通 RPC 入口拒绝机器查询，因此无法读取远程文件、diff 和 history。现在一组封闭的机器状态和文件读取复用已签名的 Streams 帧和共享响应读取器，由原生主机检查读权限，并调用现有业务处理器。history 和 Provider 发现仍不可用；diff 只允许通过需要写权限的 Code Collab 入口，因为现有处理器可能启动进程、初始化存储或刷盘。查询不领取执行 journal。大型 JSON 结果采用签名分页，独立的 RPC token 让 Guest 可以发送查询，同时不获得文档写权限。打包后的双设备验收和后端部署仍需单独完成。

## 决定与边界

本改动扩展[执行消息通道](2026-10-28-e2ee-streams-dispatch.zh.md)，保留它的执行 claim 和持久回退，不替代该决定。只读结果没有需要领取或重放的业务执行。读取与 [Code Collab 和预览](../feature/2026-10-28-e2ee-file-preview-availability.zh.md)共用 LocalMachineRpcRequest、请求分块、原生响应组装和响应读取器，避免第二套查询协议。startRpc 第四参数统一为带请求 ID、期限及取消信号的处理函数。

基线的 `getMachineRpcClient` 通过统一的 `rpc` 功能门拒绝加密工作区；主机准备能力缺失时也会返回 `e2ee_rpc_unavailable`。生产链为 cloud provider → 推导类型的 IPC 代理 → preload 白名单 → 绑定账户和窗口的主机 → 原生准备和响应验签。两个查询操作及 `rpcOnly` token 选择都通过这条链，签名私钥不会离开主机。

白名单允许十个方法名：机器状态、ping、二进制状态、会话实时状态、文件预览和下载、文本打开和刷新，以及两个现有 LSP 查询。二进制状态只检查缓存元数据，不安装缺失或不兼容的运行时。LSP 继续返回 `lsp_not_wired`，不启动服务。文本读取使用服务的只读模式，禁止 watcher、索引协调和发布。

方法名不能证明只读。Pi 发现会安装并扫描运行时；memory list 运行 Provider 命令；本地项目探测和 Git 状态会启动 Git；history read/watch 会打开后端并刷盘；diff 读取可能启动 Git/worker 或初始化 SQLite。九个方法均不进入读取通道。Pi、memory、项目探测和 history 在原生准备和接收时被拒绝；Code Collab diff 继续走需要写权限的功能通道。只有新增无副作用读取器后才能授予读权限。保存、索引发布和预览租约同样要求写权限和执行 claim；安装和认证不在功能 RPC 的允许范围。

加密文件解析先检查持久的会话、父会话和机器归属，再通过 `Session.peekHostWorkdir` 观察现有会话路径，或推导现有聊天、项目和 worktree 路径。临时 `WorktreeManager` 只计算路径并检查目录，不取得全局 manager，不 checkout、fetch 或初始化。项目注册只从机器同步所有者已持有的 Flock 中读取，快照不可用就返回不可用；读取不打开 Flock，也不发起同步。这里也拒绝使用 SDK 的 detached Flock 读取，因为冷读取时 SQLite `loadFlockDoc` 可能压缩并写盘。项目成员解析关闭链接修复，缺失目录、链接和注册保持缺失。`file/preview` 的 Markdown 发现选项明确返回不支持，因为共享解析器会运行 `git worktree list`；只返回当前根目录的候选会隐藏歧义。显式文件路径继续可读。普通工作区保留原来的解析路径。[PR 方法审计](https://github.com/LodyAI/Lody/pull/2013)列出了原来十九个方法的完整调用链。

读权限复用主机自己发起的最新账本读取及其有界内存新鲜度，再检查有效的非 recovery 成员身份和目标机器的同成员绑定。Guest 可以读取；执行仍独立要求写权限。实时密码绑定允许有效读者，主机的封闭方法和动作入口决定其可请求内容。查询不进入接收或实际启动执行 journal。收到的签名原文保存在密文 originals 存储中，同一签名者和请求 ID 下的不同字节被拒绝。新增协调使用原生 Effect，现有业务处理器和 Repo 保留 Promise 适配边界，不声称迁移了这些服务。

## 共用编码与原文保留

purpose 8 携带现有方法及规范 UTF-8 E2eeFeatureInput `{requestId, request:LocalMachineRpcRequest}`。每个 params 块为大端 uint32 序号、总数，加最多 256 KiB JSON；所有块共享安全随机的 16 字节请求 ID、方法、epoch 和期限。读取期限为 60 秒，其他功能请求保留原期限。宿主在发送前保存按长度前缀排列的全部签名帧，同一保留 ID 下改变意图会被拒绝。普通 owner session 信封只在客户端和服务端进程内适配，不是另一种网络格式。

每个 purpose 9 响应都分页承载 LocalMachineRpcResponse JSON，包括业务错误。payload 为大端 uint32 总页数、总字节数，加最多 256 KiB 原始 JSON 字节。正文 sequence 为页号；仅最后一页使用 success，前页为 progress。原生宿主校验应有页数、每页精确长度、签名者、epoch、ID 及完整请求摘要。最后一页先到也不能当成完整；同序号冲突字节不能覆盖已保存页面。全部到齐后才解码 JSON，IPC 只返回完整 DTO。Code Collab、预览和旧方法调用者共用这些完整性检查。

响应最多 64 页、16 MiB。超出返回 e2ee_query_too_large，携带 truncated:true、原大小及上限，不把部分内容当成成功；可使用文件块缩小请求。请求保留功能通道的 32 MiB 上限。原生响应所有者先加密全部页面并原子保存，再发布第一页；本地写入不确定时保留已加密页面用于重试，重开后复用已提交原帧。确认已提交结果后释放待持久化内存槽，重复的不确定提交不会耗尽后续读取容量。已提交 outbox 缺页或损坏直接失败，不重新执行业务。不引入自动回收或执行结果迁移。

## 所有权与故障范围

签名查询启动工作区 Scope 下的读取任务，最多 32 个，与执行消息接收独立。相同活动请求共用首次响应；已保存结果重发时不再次调用业务处理器。读取工作预算为 45 秒，并受原请求期限限制。超时和关闭会中止并等待底层处理器实际结束后才释放密钥；不响应取消的操作只占用自己的槽。发布前再次检查权限；不兼容 epoch 或撤销会拒绝受影响的发送。

网络故障、坏响应、outbox 故障或过期只影响对应查询，文档同步、其他请求和工作区启动继续可用。关闭先排空共享读取器和已接收的查询，再释放 RPC token。现有 originals 存储只保留密文和公开路由，不依赖执行 journal。

RPC token 通过现有 credential 认证的 content-token 操作请求 `rpcOnly:true`，其窄 scope 进入独立缓存身份。它仅允许加密桶 `<workspace>:e2ee-rpc:` 前缀内的 read/create/append。文档 token 对 Guest 保持原来的只读行为，两者都不授予 Guest 快照写权限。当前 credential、角色、epoch 和 15 分钟绝对期限继续由后端检查。配套私有改动单独审阅，不修改公共 gitlink。

## 验证限制

[主机测试](../../../../packages/loro-streams-rpc/tests/e2ee-native.test.ts)固定请求保留、分页响应原字节重试和乱序缺页行为。[查询集成测试](../../../../apps/cli/src/lib/e2ee/realtime-rpc.test.ts)经过真实方法序列化、加密 Streams 关联、目标签名和服务端读取入口。[生产 provider/preload 测试](../../../../packages/components/tests/cloud-platform-provider.test.tsx)覆盖两个查询操作和 token 用途转发；[运行时授权测试](../../../../apps/cli/tests/e2ee-runtime.test.ts)检查成员降为 Guest 后可读取自己的已准入机器，同时不能执行或访问其他成员机器。[完整装配的 Guest 查询回归](../../../../apps/cli/tests/message-handler-file-preview.test.ts)让每个允许的方法经过真实 Guest 签名准备、原生接收、MessageHandler 回调和签名响应，并比较机器文件与注入的进程状态。真实安装器和合成归档固定 Pi 在下载、安装和扫描前被拒绝，子进程边界使用内存状态。缺失的活动会话目录、缺失或过期的成员链接、未就绪的项目目录快照均保持不变，Markdown 选项在 Git 发现前被拒绝。[目录观察回归](../../../../apps/cli/src/lib/loro/machine-flock-sync-coordinator.test.ts)禁止从读取入口取得存储或传输。确定性的合成边界验证不代表公网延迟、已部署后端或打包后的双设备行为。

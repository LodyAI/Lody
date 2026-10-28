# 加密机器只读查询

Status: implemented
Translation: current

[English](2026-10-28-e2ee-read-queries.md)

## 摘要

加密工作区原先在普通 RPC 入口拒绝机器查询，因此无法读取远程文件、diff 和 history。现在查询复用已签名的 Streams 帧和共享响应读取器，由原生主机检查读权限，并调用现有业务处理器。查询不领取执行 journal。大型 JSON 结果采用签名分页，独立的 RPC token 让 Guest 可以发送查询，同时不获得文档写权限。打包后的双设备验收和后端部署仍需单独完成。

## 决定与边界

本改动扩展[执行消息通道](2026-10-28-e2ee-streams-dispatch.zh.md)，保留它的执行 claim 和持久回退，不替代该决定。只读结果没有需要领取或重放的业务执行。另建加密传输会重复机器绑定、帧、关联和清理，因此现有通道扩展输入和结果类型，两类操作共用一个响应读取器。

基线的 `getMachineRpcClient` 通过统一的 `rpc` 功能门拒绝加密工作区；主机准备能力缺失时也会返回 `e2ee_rpc_unavailable`。生产链为 cloud provider → 推导类型的 IPC 代理 → preload 白名单 → 绑定账户和窗口的主机 → 原生准备和响应验签。两个查询操作及 `rpcOnly` token 选择都通过这条链，签名私钥不会离开主机。

白名单包含机器状态、ping、二进制状态、Pi 扩展列表、memory **list**、本地项目 Git 状态和探测、会话实时状态、history read/watch、文件预览和下载、文本打开和刷新、三种 diff 读取及现有的两个 LSP 查询。memory create/update 在客户端、原生准备和服务端分别被拒绝。`init-directory` 会发布索引，因此继续关闭；保存、history 写入、预览租约、安装和认证、进程控制及从只读入口派发执行也继续关闭。加密文本和 diff 读取可以保留临时本地缓存，但不启动 watcher、不发布文件索引，也不发布 Git 观察结果。文件和 history 处理器保留路径、owner session、机器归属及存储校验。

读权限复用主机自己发起的最新账本读取及其有界内存新鲜度，再检查有效的非 recovery 成员身份和目标机器的同成员绑定。Guest 可以读取；执行仍独立要求写权限。实时密码绑定允许有效读者，主机的封闭方法和动作入口决定其可请求内容。查询不进入接收或实际启动执行 journal。收到的签名原文保存在密文 originals 存储中，同一签名者和请求 ID 下的不同字节被拒绝。新增协调使用原生 Effect，现有业务处理器和 Repo 保留 Promise 适配边界，不声称迁移了这些服务。

## JSON 分页与原文保留

purpose 8 沿用现有请求正文和方法名。params 使用明确的 UTF-8 JSON `{queryId, params}`，其中嵌套原有方法的参数 codec；owner session 加密封装和校验保持不变。主机生成安全随机的 16 字节请求 ID 和 60 秒期限，发送前保存完整签名请求。同一保留 query ID 下改变意图会被拒绝。

成功结果为 UTF-8 JSON `{result}`。每个 purpose 9 payload 是 JSON `{version:0,totalPages,totalBytes,data}`，`data` 使用带填充的规范 base64，最多承载 512 KiB 原始结果字节。正文 sequence 是从零开始的页号，仅最后一页使用 `success`，前面的页使用 `progress`。接收端验证页数、字节数、签名者、epoch、请求 ID 和完整请求摘要。即使最后一页先到，缺页也不能返回成功；相同序号的冲突字节不能替换已保存页面。全部页面到齐后才解码完整 JSON。错误使用已批准的嵌套错误正文和安全的显式业务 DTO。

结果在 base64 前限制为 32 页、16 MiB。更大结果返回 `e2ee_query_too_large`，明确携带 `truncated:true`、原大小和上限，不把部分内容当成成功。恢复使用现有 history 分页、有界文件块和 diff deferred 项。原生响应所有者先加密全部页面并原子保存，再发布第一页；本地写入不确定时保留已加密页面用于重试，重开后复用已提交的原帧。不引入自动回收或执行结果迁移。

## 所有权与故障范围

签名查询启动工作区 Scope 下的读取任务，最多 32 个，与执行消息接收独立。相同活动请求共用首次响应；已保存结果重发时不再次调用业务处理器。读取工作预算为 45 秒，并受原请求期限限制。超时和关闭会中止并等待底层处理器实际结束后才释放密钥；不响应取消的操作只占用自己的槽。history watch 获得查询和工作区合并的停止信号。发布前再次检查权限；不兼容 epoch 或撤销会拒绝受影响的发送。

网络故障、坏响应、outbox 故障或过期只影响对应查询，文档同步、其他请求和工作区启动继续可用。关闭先排空共享读取器和已接收的查询，再释放 RPC token。现有 originals 存储只保留密文和公开路由，不依赖执行 journal。

RPC token 通过现有 credential 认证的 content-token 操作请求 `rpcOnly:true`，其窄 scope 进入独立缓存身份。它仅允许加密桶 `<workspace>:e2ee-rpc:` 前缀内的 read/create/append。文档 token 对 Guest 保持原来的只读行为，两者都不授予 Guest 快照写权限。当前 credential、角色、epoch 和 15 分钟绝对期限继续由后端检查。配套私有改动单独审阅，不修改公共 gitlink。

## 验证限制

[主机测试](../../../../packages/loro-streams-rpc/tests/e2ee-native.test.ts)固定请求保留、分页响应原字节重试和乱序缺页行为。[查询集成测试](../../../../apps/cli/src/lib/e2ee/realtime-rpc.test.ts)经过真实方法序列化、加密 Streams 关联、目标签名和服务端读取入口。[生产 provider/preload 测试](../../../../packages/components/tests/cloud-platform-provider.test.tsx)覆盖两个查询操作和 token 用途转发；[运行时授权测试](../../../../apps/cli/tests/e2ee-runtime.test.ts)检查成员降为 Guest 后可读取自己的已准入机器，同时不能执行或访问其他成员机器。文件服务回归固定读取不触发后台发布。确定性的合成边界验证不代表公网延迟、已部署后端或打包后的双设备行为。

# 本地控制消息车道

Status: implemented
Translation: current
PR: [#2028](https://github.com/LodyAI/Lody/pull/2028)

[English](2026-09-20-acp-authenticate-queue-lane.md)

## 摘要

慢登录、能力探测和安装不能让无关的本地守护进程控制请求一起串行等待。`MessageProcessor` 为只读查询、取消、Provider 刷新和二进制操作分配独立车道，重启与升级共用生命周期车道。原有认证 start/control 分离保持不变。现有并发上限和执行服务的去重继续限制资源使用，本次不增加锁或重试。

## 证据与原因

最初的认证取消缺陷记录在 [#828](https://github.com/LodyAI/Lody/issues/828)：start 占用默认车道直到登录退出或 285 秒超时。取消本身已能正确终止进程，却排在 start 后无法执行；status 和 ping 也受影响。

管理者提供的 10 月 28 日线上事故中，桌面更新后首次探测内置 DeepSeek 能力，npx 在弱网下下载 `@deepseek-ai/dsh` 及其依赖，耗时数分钟。管理者统计到 745 条 `active=1` 的排队等待警告；机器状态和其它 Provider 刷新一起等待，桌面显示机器离线，创建会话失败。这些是提供的事故观察，不是测试复现的下载结果。

桌面本地路径中，`MachineRuntime.dispatchLocalMessageForResponse` 调用 `MessageProcessor.enqueue`。`ConcurrentQueue.enqueue` 将 `null` 映射到同一条 `__default__` 串行链。认证已有独立车道，但其它机器控制与会话取消仍共用默认车道。三轮 initialize/session-new 及启动槽等待可能远超状态客户端的十秒期限。

## 决策与责任

`apps/cli/src/lib/message-processor.ts` 分配以下车道：

| 请求 | 车道与顺序 |
| --- | --- |
| `session/cancel` | `session:${sessionId}:cancel`，独立于 chat |
| `machine/status`、`machine/ping` | 每种类型各一条只读车道 |
| `machine/acp-capabilities-refresh` | 按 `configId` 分车道 |
| `machine/provider-rate-limits-refresh` | 按 `configId` 分车道，与能力刷新分开 |
| `machine/acp-binary-status` | 独立只读车道 |
| `machine/acp-binary-install` | 按 `agentType` 分车道 |
| `machine/restart`、`machine/upgrade` | 共用 `machine:lifecycle` |
| `machine/acp-authenticate` | 保留 start 车道及独立、有序的 cancel/submit 控制车道 |

未列出的消息保持原映射。create/chat 仍在会话主车道上保持顺序，实际取消仍由处理器负责。认证取消先于注册到达时仍返回 `not-running`，用户可以再次取消。

restart/upgrade 处理器不依赖此前无关默认车道请求完成：它们校验授权，保存待执行的生命周期动作，回复后触发回调。二者之间仍需串行。`MachineRuntime` 另行停止接收、取消挂起请求，并在清理前最多等待五秒 drain。清理责任保持不变。

队列原有并发上限保持不变。ACP 启动仍经过 `acp-session-start-gate.ts`（默认并发二）；`session-execution-service.ts` 保留正在进行的刷新和安装的责任与去重。Effect 迁移留待后续：本次只是既有 Promise 责任内的车道选择和一个恢复条件调整，不构成完整原生生命周期单元。

## 替代方案与影响

- 取消排在 chat 或认证 start 后面，无法释放阻塞它的工作。按认证请求分车道会重现此死锁。
- 允许认证 start 并发会丢失此前的串行顺序；单一 start 车道保留该顺序，也符合登录界面一次一个流程的行为。`AcpAuthenticationManager.runningByAgentType` 继续按 Provider 互斥。独立控制车道保留控制顺序。渲染层乐观取消并非正确分发所必需。
- 全局机器车道让普通慢探测阻塞健康检查和恢复。按 Provider 分车道保留同配置顺序，资源准入仍由启动门负责。
- npx 冷初始化超时不能证明缓存损坏。`acp-npx-startup-policy.ts` 可以移除匹配包名和版本的 `_npx` 目录，随后执行 `cleanupFailedAttempt` 再重试，但保留 `_cacache` 与其它安装。真正损坏签名仍保留原有定向清理及整份 Lody 缓存的回退清理。预算、尝试次数和最终错误保持不变。

## 验证与限制

`apps/cli/tests/message-processor-permission-response.test.ts` 用显式处理器与完成信号覆盖独立控制、同配置串行、生命周期顺序、chat 期间取消与认证控制。`apps/cli/src/agent/npx-cache.test.ts` 覆盖冷超时保留已下载字节和其它安装、重试前清理、真正损坏时清空，以及整轮重试仍在共享客户端预算内。

测试验证分发与恢复策略，不验证真实弱网下载时长。远程 Machine RPC 绕过此本地队列。所有槽位被占用时，现有全局队列上限仍限制准入；本次不引入优先级调度器。

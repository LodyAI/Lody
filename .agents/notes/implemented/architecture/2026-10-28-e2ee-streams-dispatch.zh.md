# 加密 Streams 派发与持久回退

Status: implemented
Translation: current

[English](2026-10-28-e2ee-streams-dispatch.md)

## 摘要

加密远程 turn 原先需要等待 history 与 Meta 同步。此实现加入有时限的加密
Streams 收件通道，同时保留持久派发路径。可信宿主保留原始签名帧，两条入口
复用同一个执行 claim 和当前账本授权。收件 ACK 不代表执行成功。本地行为检查
通过；已测量本地回环对照；打包后的双设备验收仍未验证。

## 决定与职责

已批准的[基础协议](../../../../specs/e2ee-foundations.md)规定用途 8/9、严格的
机器资源编码和完整帧 1 MiB 上限。本次集成[正文 codec](../../proposed/architecture/2026-10-28-e2ee-realtime-body-codecs.md)；旧记录中的协议待批准前提已由已批准 Spec 取代。本次不引入 iroh。

原生宿主先把已解析 DTO 统一为 JSON 线上表示，避免 composer 的可选 `undefined`
字段与签名正文冲突。请求准备与 ACK 验收使用同一规则，不重写已保存的原件或 ID。
生产 `CloudPlatformProvider` 将这两个窄接口转发到 renderer IPC proxy 与 preload 策略。
原生宿主仅封装派发请求，在返回前把 ID、签名者、目标与完整密文存入不可变
SQLite 原件库。浏览器先将原帧写入加密会话文档，再发送实时请求。原生准备或
传输失败时，history/Meta 仍继续派发。重试复用原件；同一 turn 的冲突内容被拒绝。
renderer 不获得签名私钥或通用签名操作。

目标端验签，绑定本机与当前成员签名者。独立收件 journal 先保留原 ACK，再发布；
重启后可返回完全相同的 ACK。收件与实际执行使用不同 journal：#1992 的
`agent-start:<userTurnId>` 入口读取已验签原件，经宿主授权后才启动。收件不完成
执行 claim；执行状态不确定时维持 uncertain，避免再次执行。

原生 Effect scope 持有加密操作、有界队列和共享读流。800 ms 超时返回持久路径，
不生成新请求。单条请求的验签、存储或派发失败不影响工作区其他请求。关闭时中止
并等待 SDK 底层读完成，再释放凭据；原件库关闭失败时保留句柄供重试。本版不自动
回收执行证据。

## 证据与限制

合成真实密钥/SQLite 测试覆盖原件保留、目标/签名者/摘要绑定、原 ACK 重放、
冲突请求、授权失败、共享实际执行 claim、超时重发和关闭。新增关闭断言在修复前
发现仍有两个底层读存活，修复后通过。UI 测试覆盖原帧落入加密文档，以及成功和
失败时持久派发仍启用。挂载生产 provider 的回归使用真实 IPC proxy 和 preload
bridge，仅替换最底层 `ipcRenderer.invoke`；移除任意一个 preload 权限均会失败。
真实 composer builder 产物覆盖准备、已有原件复用和 ACK 验收，并验证修改请求仍被
拒绝。已有运行时/注册检查与受影响包类型检查已在本地运行；
没有等待托管 CI。

## 受控延迟对照

[手动测量脚本](../../../../apps/cli/scripts/benchmark-e2ee-rpc.ts)使用 Node 24.22.1，
对接锁定版本的本地 `loro dev` 网关（SQLite WAL、HTTP/1）。两种通道各预热十次，
随后交替测量各 100 次。200 条正式请求均进入合成 handler 并返回 accepted ACK。
收发端与网关均在本机回环；加密、验签、原件落盘与生产 `agent-start` claim 均为
真实实现。授权回调返回已缓存授权的合成 Authorized 结果。

| 毫秒                            |   p50 |    p95 |    p99 |
| ------------------------------- | ----: | -----: | -----: |
| 普通发送 → 合成 handler         | 0.729 |  1.134 |  3.572 |
| 加密发送 → 合成 handler         | 8.832 | 11.182 | 11.692 |
| 加密准备及原件保存              | 2.545 |  2.978 |  3.289 |
| 加密发送 → 开始入流             | 2.569 |  3.010 |  3.329 |
| 开始入流 → 目标接收             | 0.535 |  0.824 |  2.851 |
| 目标接收 → 验签完成             | 0.899 |  1.044 |  1.086 |
| 验签完成 → 收件 journal         | 2.165 |  2.675 |  2.849 |
| 收件 journal → 实际执行 journal | 2.712 |  3.408 |  3.520 |
| 实际执行 journal → 合成 handler | 0.007 |  0.015 |  0.017 |

分位数取 nearest rank，各分段的分位数不能相加。每条样本也记录入流完成。
发送计时起点在原生准备之前，包含原件持久化。普通通道使用现有机器 RPC
client/server 与相同的有效合成输入。实现没有修改普通工作区的封包。

这是组件对照，不能据此宣称一秒产品目标达标。未包含 UI、加密文档提交、watcher
调度、Electron IPC、冷启动认证账本刷新、广域网与实际 ACP/model 启动。没有运行
已配对的打包 Electron/CLI agent 环境，因此真实“发送到 agent 开始”的
p50/p95/p99 仍未测。合成 handler 在生产 claim 后进入，不代表运行中的 agent。

# M5 实时契约修订

Status: proposed
Translation: current

[English](2026-10-26-e2ee-realtime-contract.md)

## 摘要

加密远程执行需要明确字节，并让实时和持久派发共用一个持久启动边界。本修订对齐已
合入的用途专用加密原语、账本机器绑定和 schema-3 journal 恢复，候选正文字节钉在
已合入 PR-25。保留加密 history/Meta 最终回退，区分持久请求过期与仅内存执行新鲜度。
完整 Spec 仍为 draft；RPC 完整帧上限与机器资源规范编码已于 2026-10-28 获 owner
批准。MVP 采用加密 Streams RPC 加持久回退，iroh 延后为加速层；产品执行和延迟
验收仍未证实。Owner 还选择现有 90 秒通道的最小明文 presence，发布前白名单过滤
仍待接线。

## 决定与替代方案

[所属草案](../../../../specs/e2ee-foundations.zh.md#实时-rpc-与-presencem5-评审草案)
保存唯一字节 profile。保留 content v0 用途 8/9，实时重试原密文。2026-10-28
的 owner 决定选择 MVP 加密 Streams RPC 主路径与加密 history/Meta 持久派发最终
回退，两路汇入同一个实际启动 claim。Iroh 不在 MVP 中，可在后续作为加速层。
派发 ACK 是接收／progress，不是 agent 完成。保留 userTurnId 和既有 steer／fork
证据，不自动重启不确定操作。执行／请求／响应证据不自动回收；容量耗尽拒绝新工作，
不驱逐去重证据。

此前审计与开发兼容建议已由合入的机器绑定格式取代：旧开发账本按 current-only
重建，没有旧机器记录 reader 或文档同步例外。生产没有需要兼容的加密工作区。签名
tag4 和机器 possession 绑定严格 UTF-8 machineId；credential-binding/v1 继续
绑定配对 session。不另造机器绑定证明或 capability code。`rotationRequired` 只
提示管理员，单独不阻断封装、发送或执行；当前授权和 epoch 钥检查保留。

执行新鲜度从机器自己经认证读取最新账本前开始，最多 15 分钟，只缓存于内存；重启
联网认证重查。journal 独立的持久工作区过期下限不能授予该新鲜度；其认证时间偏差
检查及保留证据的显式 reset 有独立契约。reset／刷新均不续请求期限，也不允许接管
不确定操作。

两个字节点已获 **owner 批准（2026-10-28）**：

1. 对齐 PR-25：完整 RPC 内容帧最多 1,048,576 字节，包含 143 字节开销，正文最多
   1,048,433 字节。取代此前仅明文 1 MiB 的解释；预留 presence codec 不作为 MVP 上限。
2. 将账本精确的 1..256 字节严格 UTF-8 machineId 编为规范无填充 base64url，使用
   `rpc:<encodedMachineId>`，不归一化、不容许替代写法。编码段最多 342 ASCII 字节，
   完整资源最多 346。拒绝非 ASCII 或超过 128 字节的原 ID 会排除合法账本机器；有损
   归一化可能合并不同身份。PR-25 未实现此资源 codec。

2026-10-28 的 owner 决定选择加密工作区最小明文 presence：沿用现有 90 秒 TTL
通道，只发布 [Spec 白名单](../../../../specs/e2ee-foundations.zh.md#mvp-presence最小明文owner-已批准2026-10-28)
中的 ID、状态枚举和时间戳。进入任何 store／发布入口前重新构造白名单记录，去掉
status.detail 和全部自由文本、名称、路径、内容，包括嵌套字段。服务端可从连接、
流量和账号推断这些元数据，加密收益小、复杂度与可用性风险大。加密 presence 不在
MVP；用途 7 和已合入 #1990 的 presence 正文 codec 预留、不使用，64 KiB／60 秒
上限也不适用 MVP。这项明确的元数据选择不放宽 RPC／内容加密或授权。

后续非 MVP 的 iroh 层保留工作区设备签名公钥作为 EndpointId，仅在可信宿主交付
私钥。2026-10-28 的 owner 决定记录域隔离审查未发现签名协议混淆；这不等于原生
密钥生命周期或安装平台验收通过。发送到实际启动目标为 ≤1 秒，不是 ACK 或业务完成；
不声称已测得，离线持久补同步不保证一秒交付。

## 源码审计与接线边界

核对公开 main `76a4f28e8f22c0b405e57b731fb0a1e49c42d8a3`：

| 公开源码                                                                                                                         | 已有能力与限制                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/e2ee-core/src/internal/content/realtime.ts`                                                                            | presence／请求／响应共六个专用 seal/open API，处理不透明字节，不授予资源／正文、新鲜度或执行权限。用途 7 预留、MVP presence 不使用；sealDocument 保持仅文档。 |
| `packages/e2ee-core/src/internal/ledger/{records,admission,machine-id,policy}.ts`                                                | 签名 machineId／possession，严格 UTF-8 1..256 字节，同成员原子替换及有效绑定索引。已支持 capability 1 对应独立移除成员；机器 tag4 不新增 capability。         |
| `packages/e2ee-core/src/internal/ledger/verified-ledger.ts` 与 CLI `lib/e2ee/runtime.ts`                                         | 已验证连续性和 history／cache／pin，不是机器主动 latest-read 的执行新鲜度缓存。                                                                               |
| `apps/cli/src/lib/e2ee/realtime-journal.ts`                                                                                      | 尚未接线的 schema-3 存储：原件、不可变首结果、单次 claim、响应原件、工作区时钟下限及跨 reset 退役 ID。没有发送 outbox、认证、执行接线或新鲜度授权。           |
| `apps/cli/src/session/session-dispatch-watcher.ts` 与 `session-dispatch-logic.ts`                                                | RPC offer 暂存和包含重启的 history 持久派发。实际执行与 Meta/history 必须共用 claim；只在接收层去重不够。                                                     |
| `packages/loro-streams-rpc/src/machine-rpc-server.ts`、CLI `session-history-rpc-rejections.ts` 和 `session-execution-service.ts` | 既有内存 history task 去重、过期拒绝和 steer 不确定证据可复用，不是已经接好的持久执行门。                                                                     |

PR-25 **已合入**（merge `c7b3c71512e2bdf26b14817fc8ff56cbd730f509`），源码钉在
[`daee5751fde6698e50960ca6a5627191c887e297`](https://github.com/LodyAI/Lody/pull/1990)：
[纯正文 codec](https://github.com/LodyAI/Lody/blob/daee5751fde6698e50960ca6a5627191c887e297/packages/loro-streams-rpc/src/e2ee-wire.ts)
与[独立 Python 向量](https://github.com/LodyAI/Lody/blob/daee5751fde6698e50960ca6a5627191c887e297/packages/loro-streams-rpc/tests/fixtures/generate-e2ee-wire.py)
给出字段顺序、安全大端整数、ASCII 方法／错误文本、原样不透明 payload、嵌套错误
验证及大小上限。不认证调用方、不查当前时间、不关联响应、不分配持久序号、不实现
资源编码。其 presence codec 预留、MVP 不使用。本修订只改文档，不改 RPC 或 codec 字节。

相关公开决定：[机器绑定](2026-10-27-e2ee-machine-ledger-binding.zh.md)、
[实时原语](2026-10-26-e2ee-realtime-content-primitives.zh.md)、
[journal](2026-10-26-e2ee-realtime-journal.zh.md) 和
[journal 恢复](../bug-fix/2026-10-27-e2ee-realtime-journal-recovery.zh.md)。
共享 presence schema 仍允许有界 status.detail；加密工作区发布白名单仍待接线。
本修订取代早先 M5 加密 presence 提议和过时审计，不改变底层原语／codec 已有能力
或普通工作区 presence 行为。

## 验证边界

[PR #1894](https://github.com/LodyAI/Lody/pull/1894) 保持 draft；四份 Spec 均为 draft，
双语 Note 均 proposed/current。文档检查只验证元数据／链接，不代表最终 Spec 批准
或运行时行为。两个格式点批准不改变 Spec 状态：最终批准仍待独立 PR-25／wire
一致性审查及之后 owner 明确批准。已对照指定 PR-25 codec 和独立生成的向量，
不复制候选实现，也不加新测试套件。认证传输／新鲜度、发送 outbox、查询授权、实际执行和持久回退、真实
网关、原生／平台和延迟验收仍待接线。本 revision 的检查记录在 PR 描述；旧检查／评审
结果不作为此次 revision 的证据。

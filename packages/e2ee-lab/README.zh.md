# @lody/e2ee-lab

E2EE 的独立 catalog 固定为 Effect **4.0.2**。`LabRun` 为每个所有者只构建一次服务，保持长期 Scope，关闭时中断活跃 fiber 并等待资源释放。host 在 Scope 中获取 SQLite、Riverrun 和 HTTP 资源，启动失败也会清理；Promise 调用方须等待 `host.close()`、`session.close()`。session 的账本意图调用声明依赖的 `SessionLedger` workflow；HTTP 处理器和 streams-crdt 回调仍是明确的原生 Promise 桥接。

每个 runtime 用自己的 Ref 保存调度状态。Deferred 门控仍须明确许可；请求与完成通知唤醒 Scope 中的队列消费者，替代定时轮询。Effect Clock 的超时保护与逻辑调度分开。原生 SDK 回调继续通过明确的 AsyncLocalStorage 桥接传递嵌套事件的父级。`runtime.close()` 拒绝待许可操作；等待 `runtime.dispose()` 才完成 fiber 清理。

[English](README.md)

本地确定性 E2EE 协作实验室。不是产品 E2EE，也不接入 Lody。诚实客户端是程序；
只有攻击 Agent（P4）在已记录的事件边界探索恶意服务器改动。

轮换恢复使用 core 对精确候选记录的分类。损坏的 pending journal 不当作空状态；
已确认候选先保存到密钥文件，再对内存开放。写盘失败保留候选用于重试。密钥承诺
和信封使用 Org 哈希，不使用创世记录全文。旧错误上下文的录制不会静默迁移，须
在修正后的代码上重新录制证据。

## 命令

```sh
pnpm --filter @lody/e2ee-lab check
pnpm --filter @lody/e2ee-lab run scenario:collab
pnpm --filter @lody/e2ee-lab run attack:model   # 需要模型密钥（OPENROUTER_KEY 等）
pnpm --filter @lody/e2ee-lab run replay
pnpm --filter @lody/e2ee-lab exec tsx src/repro-cli.ts replay /path/to/pack
pnpm --filter @lody/e2ee-lab exec tsx src/cli.ts --data-dir /tmp/e2ee-lab-data
pnpm --filter @lody/e2ee-lab exec tsx src/cli.ts --data-dir /tmp/e2ee-lab-data --test
```

`check` 是类型检查加测试。根命令不构建旧 demo UI。`scenario:collab` 运行
多人持续协作脚本（Alice/Bob/Carol/Dave/Eve，离线重连、撤权换代、快照引导、
移除 Eve 及移除到换代之间的窗口、移除前排队并在之后上传的离线编辑、降为
Guest、崩溃恢复），先无攻击对照，再在指定事件边界注入固定攻击，包括只对
Bob 隐藏 Eve 被移除的按客户端分叉视图。从 Eve 被移除起，攻击者持有她保留的
密钥（`insiderRead`）；裁判检查此后封装的内容都无法用这些密钥打开。报告按属性
逐条给出判定（`report.properties`）。`attack:model` 运行有预算的多轮模型
Agent：可等待指定步骤、行动、读取错误与内部人读取结果，再继续行动。可用
`E2EE_AGENT_GOAL`（`insider-read`、`forge-content`、`ledger-fork`、`any`）、
`E2EE_AGENT_MODEL`、`E2EE_AGENT_TEMPERATURE`（默认 0.7）、`E2EE_AGENT_SEED`、
`E2EE_AGENT_MAX_DECISIONS`，或自定义 `E2EE_AGENT_URL`/`E2EE_AGENT_KEY` 配置。
`replay` 在三个新目录中无模型
重放 CAS、丢 ACK、密文篡改和同一份攻击记录，并在首个事件、随机请求、
协议帧或客户端状态分歧处失败。私有设备材料留在测试进程内，不写入公开记录。
独立复现包（`e2ee-lab-repro/v1`）绑定 HEAD **和**脏树哈希；`repro-cli.ts replay`
在新进程中运行，只打印失败指纹。私有材料权限为 0700，不写到 stdout。

## 后端

宿主是 `src/platform/host.ts` 前面的薄网关，后面才是官方 sqlite Riverrun
`0.3.0`。Riverrun 只存密文并做 CAS；Org 成员与写权由已验证账本决定，不写进
Riverrun 表。恶意服务器测试仍直连 `riverrunUrl`。没有浏览器 UI。需要 vendor
的 continuationOffset streams-crdt tarball。

## 状态

P2 重放见 `test/replay-bytes.test.ts`。P3 固定攻击矩阵见 `test/matrix.test.ts`。
P4 AttackLab 隔离与无 LLM 动作重放见 `test/attack-lab.test.ts`。多人持续协作、
边界攻击与三目录无模型重放见 `test/collab-scenario.test.ts`；真实模型介入见
`test/restricted-agent.test.ts`。AttackLab 的时钟/文件/HTTP 经 Effect
`LabClock` / `LabFs` / `LabHttp`（`src/services/`）；Promise 方法提供
`LiveLabLayer`。隔离只是能力句柄，不是 OS 容器，Effect 也不是沙箱。

轮换已委托 core Effect 流程，不再在 Lab 重复实现候选签名、重试与安装。
正常文件写入使用原子替换/fsync 适配器；注入 `LabFs` 仍支持确定性故障测试。
密钥与候选 JSON 格式不变，`.lock.sqlite` 只存锁的运行元数据。
不同操作占用 pending 时返回类型化 `PendingOperationExists`，磁盘失败返回
`StorageError`，不再笼统视为结果未知。仍列出的 Promise SDK 边界：host 每次
HTTP 请求上的 `Ledger.verify`/`extend`、streams-crdt 的
`createStreamsContentProvider`、`createContentSnapshotPublication`，以及演示
`backup.ts` 文件封装。它们只解包 core 流程，不是第二套内容或准入算法。
复现包、指纹和缩减见 `test/repro-pack.test.ts`。streams-crdt import/read 的嵌套
请求顺序不是可控 microtask 边界；协作重放使用最早可运行 FIFO。SIGKILL 崩溃
恢复有测试；未刷盘 SQLite 页的断电未建模。见
[实施说明](../../.agents/notes/proposed/testing/2026-09-16-e2ee-adversarial-lab.zh.md)。

## 中央密钥信箱

`DemoSession.centralKeyRound(limit)` 是显式、有限一轮的应用事件入口，经
`/v1/spaces/{genesis}/key-mailbox` 协调当前钥分发、持久接收日志、设备签名报告和
修复/结果恢复。宿主要求 Org 绑定凭证，并独立刷新已验证账本；SQLite 信箱/索引
同库原子，不与 Riverrun control 原子。客户端 `key-distribution.sqlite` 保留跨重启
任务和未消费结果。旧脚本的 `keys` 流仍可用；core 协调器另提供显式修复和结果确认。
这是参考 HTTP 宿主，不是 Convex 部署或已启用产品 E2EE。见
[投递草案](../../specs/e2ee-central-key-delivery.zh.md)与
[验收测试](test/central-key-delivery.test.ts)。

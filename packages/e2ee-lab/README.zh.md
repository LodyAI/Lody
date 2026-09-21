# @lody/e2ee-lab

[English](README.md)

本地确定性 E2EE 协作实验室。不是产品 E2EE，也不接入 Lody。诚实客户端是程序；
只有攻击 Agent（P4）在已记录的事件边界探索恶意服务器改动。

## 命令

```sh
pnpm --filter @lody/e2ee-lab check
pnpm --filter @lody/e2ee-lab run scenario:collab
pnpm --filter @lody/e2ee-lab run attack:model   # 需要模型密钥（OPENROUTER_KEY 等）
pnpm --filter @lody/e2ee-lab run replay
pnpm --filter @lody/e2ee-lab exec tsx src/repro-cli.ts replay /path/to/pack
pnpm --filter @lody/e2ee-lab exec tsx src/cli.ts --data-dir /tmp/e2ee-lab-data
```

`check` 是类型检查加测试。根命令不构建旧 demo UI。`scenario:collab` 运行
多人持续协作脚本（Alice/Bob/Carol/Dave，离线重连、撤权换代、快照引导、
崩溃恢复），先无攻击对照，再在指定事件边界注入固定攻击。`attack:model`
让真实模型在协作进行中选择边界与攻击动作。`replay` 在三个新目录中无模型
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
复现包、指纹和缩减见 `test/repro-pack.test.ts`。streams-crdt import/read 的嵌套
请求顺序不是可控 microtask 边界；协作重放使用最早可运行 FIFO。SIGKILL 崩溃
恢复有测试；未刷盘 SQLite 页的断电未建模。见
[实施说明](../../.agents/notes/proposed/testing/2026-09-16-e2ee-adversarial-lab.zh.md)。

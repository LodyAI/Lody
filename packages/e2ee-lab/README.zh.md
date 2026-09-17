# @lody/e2ee-lab

[English](README.md)

本地确定性 E2EE 协作实验室。不是产品 E2EE，也不接入 Lody。诚实客户端是程序；
只有攻击 Agent（P4）在已记录的事件边界探索恶意服务器改动。

## 命令

```sh
pnpm --filter @lody/e2ee-lab check
pnpm --filter @lody/e2ee-lab run scenario:collab
pnpm --filter @lody/e2ee-lab run replay
pnpm --filter @lody/e2ee-lab exec tsx src/cli.ts --data-dir /tmp/e2ee-lab-data
```

`check` 是类型检查加测试。根命令不构建旧 demo UI。`replay` 在三个新目录中重放 CAS、丢 ACK 和密文篡改，并在首个事件、随机请求或协议帧分歧处失败。私有设备材料留在测试进程内，不写入公开记录。

## 后端

宿主在 `src/platform/host.ts`，使用官方 sqlite Riverrun `0.3.0` 与 vendor 的
continuationOffset streams-crdt tarball。没有浏览器 UI。

## 状态

P2 重放见 `test/replay-bytes.test.ts`。P3 固定攻击矩阵见 `test/matrix.test.ts`。
P4 AttackLab 隔离与无 LLM 动作重放见 `test/attack-lab.test.ts`。隔离只是能力句柄，
不是 OS 容器，Effect 也不是沙箱。见
[实施说明](../../.agents/notes/proposed/testing/2026-09-16-e2ee-adversarial-lab.zh.md)。

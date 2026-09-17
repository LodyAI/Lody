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

第一版实验室 host 复用 `@lody/e2ee-demo/host` 的官方 sqlite Riverrun 适配。
P5 在场景矩阵覆盖后把适配迁到本包并删除 demo/game UI。

## 状态

P2 重放和 P3 固定攻击矩阵见 `test/replay-bytes.test.ts` 与 `test/matrix.test.ts`。
Agent API 属于 P4。见
[实施说明](../../.agents/notes/proposed/testing/2026-09-16-e2ee-adversarial-lab.zh.md)。

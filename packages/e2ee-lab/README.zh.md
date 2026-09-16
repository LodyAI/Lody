# @lody/e2ee-lab

[English](README.md)

本地确定性 E2EE 协作实验室。不是产品 E2EE，也不接入 Lody。诚实客户端是程序；
只有攻击 Agent（P4）在已记录的事件边界探索恶意服务器改动。

## 命令

```sh
pnpm --filter @lody/e2ee-lab check
pnpm --filter @lody/e2ee-lab run scenario:collab
pnpm --filter @lody/e2ee-lab exec tsx src/cli.ts --data-dir /tmp/e2ee-lab-data
```

`check` 是类型检查加测试。根命令不构建旧 demo UI。重放命令在 P2 提供。

## 后端

第一版实验室 host 复用 `@lody/e2ee-demo/host` 的官方 sqlite Riverrun 适配。
P5 在场景矩阵覆盖后把适配迁到本包并删除 demo/game UI。

## 状态

当前门槛是 P1 三人常驻协作。攻击记录、重放和 Agent API 属于后续阶段。见
[实施说明](../../.agents/notes/proposed/testing/2026-09-16-e2ee-adversarial-lab.zh.md)。

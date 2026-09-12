# 仅在有观察者时加入 machine-monitor 流

Status: implemented
Translation: current

[English](2026-09-10-lazy-machine-monitor-stream.md)

## 摘要

此前每个云端工作区渲染进程都会在运行时启动时加入 machine-monitor Ephemeral Stream，哪怕当时没有任何 UI 在展示机器资源快照。渲染进程现在保留已认证的连接输入，但只在第一个 machine-monitor 订阅者出现后才加入，并在最后一个订阅者离开后关闭房间。Presence 仍是工作区生命周期内的订阅，因为它支撑着彼此独立的在线状态与会话浏览状态。观察者快速变化时，拆除与新的加入可能短暂重叠，但以 generation 为闸门的传输层清理可确保旧订阅不会残留。

## 决策与归属

`WorkspaceMachineMonitorTransport` 拥有观察者计数的生命周期，因为只有它同时拥有快照监听器与 Ephemeral Stream 订阅。`createWorkspaceRuntime` 继续在云端 attach 时提供当前连接输入，并在 detach、token 丢失和运行时销毁时停止该传输层。

观察者会立即收到本地的空快照，随后启动远端房间并发布自己的观察者租约。最后一个观察者清除其租约并拆除远端房间。CLI 继续只为活跃的观察者租约采样。

## 证据与验证

- `packages/components/src/providers/workspace-machine-monitor-transport.ts`
- `packages/components/tests/workspace-machine-monitor-transport.test.ts`

回归测试证明：仅工作区 attach 不会创建 machine-monitor 传输层；第一个观察者会创建一个；最后一个观察者会关闭它；之后新的观察者会创建一个全新的传输层。

# 只有权威工作区列表可以拒绝本机机器配对

Status: implemented
Translation: current

[English](2026-10-30-e2ee-pairing-first-workspace-list.md)

## 摘要

桌面端在 **Run local agent** 关闭时创建加密工作区，之后开启该设置并点击 **Enable local agent**，会被 `e2ee_local_agent_unavailable` 拒绝。新启动的 CLI daemon 从本地工作区目录引导，而该目录从未见过这个工作区；它报告 `ready`，并在首个已认证工作区列表应用之前就响应本机配对。Fleet 的账号/工作区/genesis 检查把这次缓存缺失当成了 `e2ee_binding_conflict`。现在仅当缓存条目缺失或 genesis 不同时，配对才等待首个权威列表结果，然后执行不变的检查；缓存匹配时仍无需网络即可继续。

## 决策

`LodyFleet.dispatchLocalE2eePairing` 保留原前置条件：Fleet 账号、`desiredWorkspaces` 中的 `e2ee` 工作区以及相同的 genesis 哈希。前置条件不满足时，它等待一个进程级信号；该信号在以下任一情况结算：首个远端列表应用完成（成功或失败）、令牌或身份被拒、订阅错误、关闭。随后重新检查停止、重置和同一前置条件；任何不匹配仍以原错误失败。prepare 与 activate 经过同一检查，因此共用此门禁。

机器登记与此无关。服务端 CLI 列表按账号成员关系包含加密工作区；未配对的加密工作区在等待配对期间本就不在 `connectedWorkspaces` 中。这是就绪竞态，不是循环依赖。它自 [#1814](https://github.com/LodyAI/Lody/pull/1814) 在既有本地优先引导之上加入 Fleet 检查起存在；本地优先引导会在订阅之前设置 `startupStage=ready`。

## 备选方案

- **远端列表到达后才报告 daemon 就绪。** 这会为一条配对路径拖慢每次桌面启动和离线使用，而本地优先引导正是为避免这一点。
- **在 Electron 或渲染层重试。** CLI 拥有权威列表，可以在本地等待；调用方重试循环只能猜测时机，并把真正的绑定冲突变成重复请求。
- **接受目录缓存或请求中的 genesis。** 两者都会削弱配对依赖的绑定检查。

## 故障隔离

- **触发：** 每次 daemon 冷启动且目录缺少某个加密工作区时，直到首个列表到达。
- **扩散：** 仅前置条件失败的本机 prepare/activate 请求会等待。缓存匹配、其他控制路由与工作区启动不变。
- **期限：** 信号在首个列表的每种结果以及关闭时结算。若都未到达，Electron 的 30 秒本机控制超时报告 `e2ee_local_agent_pending`，界面已将其视为可重试。
- **结果：** 等待中的请求只有在权威列表匹配后才继续。不缓存任何结果，也不会从等待状态接受绑定。

## 验证

`apps/cli/tests/lody-fleet-local-catalog.test.ts`（`LodyFleet local E2EE pairing during startup`）以空目录和挂起的订阅启动 Fleet，证明请求会等待并在列表到达后完成 prepare，而缺失工作区、genesis 不同或令牌被拒时仍拒绝。该处对原生准备打桩，因为其托管行为由 `apps/cli/tests/e2ee-runtime.test.ts` 覆盖。带真实 Secret Service 的打包双桌面旅程尚未在此修改上重跑。

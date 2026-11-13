# E2EE 原生内容快照（PR-17 MVP）

Status: proposed
Translation: current

- Date: 2026-10-27
- PR: [#1959](https://github.com/LodyAI/Lody/pull/1959), [#2728](https://github.com/LodyAI/Lody/pull/2728)
- 配套后端：[#3873](https://github.com/loro-dev/lody/pull/3873)
- English: [English](2026-10-27-e2ee-native-content-snapshots.md)

## 摘要

M2 关闭了加密内容快照，新副本必须读取全部增量。PR-17 通过已有宿主加密与签名能力打开原生 Streams 快照。读取方检查历史上已入账的签名者、可解 epoch、签名、续传位置和 AEAD；快照不合格时若历史仍在则立即从头回放。MVP 信任服务端和上传者如实关联原生快照、内容与 offset，签名提供追责能力，不证明这种关联。真实生产网关和整个工作区的性能仍需独立验收。

## 决定与边界

Owner 于 2026-10-27 选择直接使用原生快照，不保留历史快照，生产 trim 宽限期按 48 小时处理。本次有意推迟 [foundations 草案](../../../../specs/e2ee-foundations.md#settled-content-v0-and-snapshot-continuation) 的独立 record-boundary 能力，不等待上游对应接口；不修改 Spec。快照建立 48 小时后，旧记录可能被清理，完整回放不再是必然可用的恢复来源。不改变账本、内容 v0、本地存储格式，不增加格式回退或 gitlink 改动。

桌面 main 与 CLI 宿主保管所有密钥和签名能力。既有 header 4 签名覆盖整个加密快照 frame 及续传位置，room AAD 绑定工作区、资源和模型。与已合入的 #1954 组合后，同一次 seal 的头部、加密和签名始终沿用一次选定的 `writeEpoch`，包括换代期间完成的在途封装；等待或手动换代时可用不晚于当前的保留发布纪元，签名前后仍检查当前写权限。读取先验证历史签名再取 key，随后检查 AEAD 和精确原生续传位置。同日 owner 的后续决定覆盖初版当前写者读取限制：历史已入账设备被撤销后，其快照签名仍可接受；从未入账的密钥不能通过。最后复用自行持有的已验证字节与真实账本延续关系。上传仍要求当前写权限及所选发布纪元。生产没有已有加密工作区，不保留旧快照格式读取路径。

## 调度与恢复

仅本地写入触发 SDK 快照调度。最后一次本地写入后防抖 30 秒，检查远端快照，并要求至少新增 1 MiB stream 数据（`minBytesSinceRemoteSnapshot`）。常规情况下防抖期间观察到其他写者（`observedForeignWriter`）则抑制上传；但当距离远端上次快照的新增字节数达到硬上限 `maxBytesSinceRemoteSnapshot`（4 MiB）时，不再因观察到外部写者而无限期抑制上传，避免人类与远程 Agent 或多端高频交替写入时一直无法产出加密快照。上传仍要求已完整持久化进度且没有待发送本地写入。SDK 跨 room 代次持有一个上传任务。多设备仍可能竞争，这是尽力协调，不是分布式选主。调度许可只是提示，core seal 才决定权限。

SDK 在同一次串行捕获中取得原生状态和 offset；压缩、签名与上传不占用编辑队列。上传失败只记录日志，后续本地写入可以再试，不拒绝编辑或增量发送。

固定 streams-crdt 0.19.2 补丁标记受保护快照的解码失败，并在 CRDT 导入和 cursor 保存之前拒绝非起点位置的缺失/空快照；空响应不能证明非起点 cursor。失败后丢弃 bootstrap 的后缀，通过相同加密增量验证及持久化屏障从头读取（`catchupOrGone(this.createInitialCursor(), ...)`）；若历史已被清理（410 Gone），则直接向上层报告受保护快照恢复失败并保留本地状态与 cursor。此前在每个在线加密房间每 5 秒对 `<native-stream>:snapshot-repair` 发起 `HEAD` 轮询及写补传标记的机制已在 [#2728](https://github.com/LodyAI/Lody/pull/2728) 中移除，避免常态下持续产生无意义的 404 轮询开销。

根 pnpm `patchedDependencies` 应用 `patches/@loro-dev__streams-crdt@0.19.2.patch`，lockfile 固定其 hash；frozen 安装拒绝缺失或不一致的补丁。升级 SDK 时应迁移补丁，或用所属 transport 测试证明上游已有等效行为：坏签名/tag/offset/key 的历史回退以及 `maxBytesSinceRemoteSnapshot` 强制快照门限。撤掉补丁会使这些行为测试失败。私有外层采用合入后的公共 head 时，必须用 `lody-oss/patches/` 路径同步补丁声明并更新自身 lockfile；本次不改 gitlink。

## 证据与限制

确定性测试使用真实 Loro、IndexedDB、加密和宿主保管流程，密钥为合成数据。覆盖快照加后缀、坏签名、AEAD、续传位置、快照 key 不可用、非起点缺失快照、完整历史回退、历史已清理时保留本地状态与 cursor 并拒绝损坏快照，以及多写者高频交替写入达到 4 MiB 硬上限时强制触发快照上传。普通 native 并发 join 仍共享一个 owner，关闭后停止全部在线任务。Core 接受打开前或取 key 期间已撤销的历史签名者，拒绝从未入账的签名者及跨工作区/文档重放。受影响检查和可撤回变异结果记录在 PR 中。

已有有限步骤的 core 继续使用原生 Effect。Repo/SDK Promise 集成保留在原有应用 facade；迁移尚未完成的依赖会扩大任务，无法直接改善本次快照边界。

Lab 区分可成功回放的已验证历史与历史已清理的坏快照；后者保留 SDK 经验证的 410 恢复原因，不把先前 provider 异常误判为本地损坏。SQL 拒写仍保留数据与 cursor 两部分。Loro/Flock 三角色计划验证真实 bootstrap 与持久结果的重新打开，不伪造宿主历史。旧 CLI actor 失败由 main 已批准的 Claude 子模块 pin 修复，原断言保留。

[隔离 Electron 测量](../../../../apps/electron/scripts/e2ee-ipc-benchmark.md) 记录性能与限制。Docker 预检未发现运行中的 daemon（缺少 `~/.orbstack/run/docker.sock`），因此未验证私有 local-stack / 真实 gateway、生产 48 小时 trim 配置、真实 OS 密钥保管、安装包、其他平台或整个工作区启动。本轮不增加整个产品的性能结论。

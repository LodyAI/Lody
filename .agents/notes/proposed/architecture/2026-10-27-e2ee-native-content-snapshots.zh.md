# E2EE 原生内容快照（PR-17 MVP）

Status: proposed
Translation: current

- Date: 2026-10-27
- PR: [#1959](https://github.com/LodyAI/Lody/pull/1959)
- 配套后端：[#3873](https://github.com/loro-dev/lody/pull/3873)
- English: [English](2026-10-27-e2ee-native-content-snapshots.md)

## 摘要

M2 关闭了加密内容快照，新副本必须读取全部增量。PR-17 通过已有宿主加密与签名能力打开原生 Streams 快照。读取方检查历史上已入账的签名者、可解 epoch、签名、续传位置和 AEAD；快照不合格时自动请求补传，历史仍在则立即回放。MVP 信任服务端和上传者如实关联原生快照、内容与 offset，签名提供追责能力，不证明这种关联。真实生产网关和整个工作区的性能仍需独立验收。

## 决定与边界

Owner 于 2026-10-27 选择直接使用原生快照，不保留历史快照，生产 trim 宽限期按 48 小时处理。本次有意推迟 [foundations 草案](../../../../specs/e2ee-foundations.md#settled-content-v0-and-snapshot-continuation) 的独立 record-boundary 能力，不等待上游对应接口；不修改 Spec。快照建立 48 小时后，旧记录可能被清理，完整回放不再是必然可用的恢复来源。不改变账本、内容 v0、本地存储格式，不增加格式回退或 gitlink 改动。

桌面 main 与 CLI 宿主保管所有密钥和签名能力。既有 header 4 签名覆盖整个加密快照 frame 及续传位置，room AAD 绑定工作区、资源和模型。与已合入的 #1954 组合后，同一次 seal 的头部、加密和签名始终沿用一次选定的 `writeEpoch`，包括换代期间完成的在途封装；等待或手动换代时可用不晚于当前的保留发布纪元，签名前后仍检查当前写权限。普通和补传快照均复用此换代 provider。读取先验证历史签名再取 key，随后检查 AEAD 和精确原生续传位置。同日 owner 的后续决定覆盖初版当前写者读取限制：历史已入账设备被撤销后，其快照签名仍可接受；从未入账的密钥不能通过。最后复用自行持有的已验证字节与真实账本延续关系。上传仍要求当前写权限及所选发布纪元。生产没有已有加密工作区，不保留旧快照格式读取路径。

## 调度与恢复

仅本地写入触发 SDK 快照调度。最后一次本地写入后防抖 30 秒，检查远端快照，并要求至少新增 1 MiB stream 数据。防抖期间观察到其他写者则抑制上传；必须已完整持久化进度且没有待发送本地写入。SDK 跨 room 代次持有一个上传任务。多设备仍可能竞争，这是尽力协调，不是分布式选主。调度许可只是提示，core seal 才决定权限。

SDK 在同一次串行捕获中取得原生状态和 offset；压缩、签名与上传不占用编辑队列。上传失败只记录日志，后续本地写入可以再试，不拒绝编辑或增量发送。补传复用同一上传 owner，跳过普通字节、防抖和竞争写者限制，允许同一 offset 替换；仍要求写权限、完整 cursor/状态、没有待发送本地写入以及当前房间所有权。

固定 streams-crdt 0.19.2 补丁标记受保护快照的解码失败，并在 CRDT 导入和 cursor 保存之前拒绝非起点位置的缺失/空快照；空响应不能证明非起点 cursor。失败后丢弃 bootstrap 的后缀，通过相同加密增量验证及持久化屏障从头读取，无需等待补传。读取方同时向 `<native-stream>:snapshot-repair` 请求写入固定一字节标记，TTL 120 秒、请求合并间隔 30 秒。Guest 通过既有设备认证的 content-token action 请求后端代写；exact-stream 写 token 留在后端。受保护 SDK 恢复通知覆盖未进入 `provider.open` 的缺失/损坏 envelope；通知失败不改变同步结果。正常 Guest 内容 token 仍只读，后端不读取或写入业务 CRDT 内容。

每个在线加密房间每五秒轮询标记；持有完整内容且当前有写权限的设备补传，每个设备/房间最多每 30 秒成功补传一次。失败后下次轮询仍可重试，不影响编辑或发送。若历史已清理，原在线订阅等待，并按同一间隔重试 bootstrap；有效新快照出现后自动完成。关闭取消等待、所属请求与定时器。桌面显示正在请求补传和自动重试的提示，CLI 使用固定诊断文字与经验证字段，不展示原始 provider 异常。保留本地状态和 cursor。不新增分布式选主或服务端基础设施。普通工作区不创建该通道、定时器或请求流量。

根 pnpm `patchedDependencies` 应用 `patches/@loro-dev__streams-crdt@0.19.2.patch`，lockfile 固定其 hash；frozen 安装拒绝缺失或不一致的补丁。升级 SDK 时应迁移补丁，或用所属 transport 测试证明上游已有等效行为：坏签名/tag/offset/key 的历史回退、无需再次编辑的自动补传、等待时关闭。撤掉补丁会使这些行为测试失败。私有外层采用合入后的公共 head 时，必须用 `lody-oss/patches/` 路径同步补丁声明并更新自身 lockfile；本次不改 gitlink。独立私有后端 PR 提供 snapshot-write 权限与 Guest 代写，两边齐备后才能进行 cloud 验收。

## 证据与限制

确定性测试使用真实 Loro、IndexedDB、加密和宿主保管流程，密钥为合成数据。覆盖快照加后缀、坏签名、AEAD、续传位置、快照 key 不可用、非起点缺失快照、完整历史回退、历史已清理时保留状态并等待、同一 offset 自动替换及关闭取消。完整写者在普通防抖期间观察到其他写者后，仍可绕过生产 1 MiB 门槛完成补传；普通 native 并发 join 仍共享一个 owner，关闭后停止全部在线任务。Core 接受打开前或取 key 期间已撤销的历史签名者，拒绝从未入账的签名者及跨工作区/文档重放。受影响检查和可撤回变异结果记录在 PR 中。

已有有限步骤的 core 继续使用原生 Effect。Repo/SDK Promise 集成保留在原有应用 facade；迁移尚未完成的依赖会扩大任务，无法直接改善本次快照边界。

Lab 区分可成功回放的已验证历史与历史已清理的坏快照；后者保留 SDK 经验证的 410 恢复原因，不把先前 provider 异常误判为本地损坏。SQL 拒写仍保留数据与 cursor 两部分。Loro/Flock 三角色计划验证自动重试下一次真实 bootstrap，并重开其持久结果，不伪造宿主历史。旧 CLI actor 失败由 main 已批准的 Claude 子模块 pin 修复，原断言保留。

[隔离 Electron 测量](../../../../apps/electron/scripts/e2ee-ipc-benchmark.md) 记录性能与限制。Docker 预检未发现运行中的 daemon（缺少 `~/.orbstack/run/docker.sock`），因此未验证私有 local-stack / 真实 gateway、生产 48 小时 trim 配置、真实 OS 密钥保管、安装包、其他平台或整个工作区启动。隔离性能测量早于自动补传改动，本轮不增加整个产品的性能结论。

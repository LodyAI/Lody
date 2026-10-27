# E2EE 原生内容快照（PR-17 MVP）

Status: proposed
Translation: current

- Date: 2026-10-27
- PR: [#1959](https://github.com/LodyAI/Lody/pull/1959)
- English: [English](2026-10-27-e2ee-native-content-snapshots.md)

## 摘要

M2 关闭了加密内容快照，新副本必须读取全部增量。PR-17 通过已有宿主加密与签名能力打开原生 Streams 快照。读取方检查当前有效写设备、可解 epoch、签名、续传位置和 AEAD；快照不合格时回放加密历史。MVP 信任服务端和上传者如实关联原生快照、内容与 offset，签名提供追责能力，不证明这种关联。真实生产网关和整个工作区的性能仍需独立验收。

## 决定与边界

Owner 于 2026-10-27 选择直接使用原生快照，不保留历史快照，生产 trim 宽限期按 48 小时处理。本次有意推迟 [foundations 草案](../../../../specs/e2ee-foundations.md#settled-content-v0-and-snapshot-continuation) 的独立 record-boundary 能力，不等待上游对应接口；不修改 Spec。快照建立 48 小时后，旧记录可能被清理，完整回放不再是必然可用的恢复来源。不改变账本、内容 v0、本地存储格式，不增加格式回退或 gitlink 改动。

桌面 main 与 CLI 宿主保管所有密钥和签名能力。既有 header 4 签名覆盖整个加密快照 frame 及续传位置，room AAD 绑定工作区、资源和模型。签名前后都检查当前 epoch 和写权限。读取先验证历史签名再取 key，随后检查 AEAD 和精确原生续传位置；取 key 前和解密后都要求签名者仍是非 Guest 的有效个人或机器写设备。历史增量仍允许读取已撤销设备当时合法签名的数据。最后一次快照检查复用已验证且自行持有的字节及真实账本延续关系，只重查当前权限，避免重复验签。

## 调度与恢复

仅本地写入触发 SDK 快照调度。最后一次本地写入后防抖 30 秒，检查远端快照，并要求至少新增 1 MiB stream 数据。防抖期间观察到其他写者则抑制上传；必须已完整持久化进度且没有待发送本地写入。SDK 跨 room 代次持有一个上传任务。多设备仍可能竞争，这是尽力协调，不是分布式选主。调度许可只是提示，core seal 才决定权限。

SDK 在同一次串行捕获中取得原生状态和 offset；压缩、签名与上传不占用编辑队列。上传失败只记录日志，后续本地写入可以再试，不拒绝编辑或增量发送。关闭继续使用既有 SDK owner；没有新增全局阻断、持久失败集合、后台定时器或清理 owner。

固定 streams-crdt 0.19.2 补丁仅标记受保护快照的解码失败，位置在 CRDT 导入和 cursor 保存之前。失败后丢弃 bootstrap 的后缀，通过相同加密增量验证及持久化屏障从头读取。410 直接结束本次尝试，不反复 bootstrap。经校验的错误字段带上 `protocol_error` / `payload_protection` / `bootstrap` / `gone`，共享格式化层提示持有数据的设备发布新快照后重试，不显示原始异常文字。快照修复后同一读取方可重试，保留草稿和 cursor。普通工作区保留原有快照、上传、错误与传输路径。

## 证据与限制

确定性测试使用真实 Loro、IndexedDB、加密和宿主保管流程，密钥为合成数据。覆盖快照加后缀、坏签名、AEAD、续传位置、快照 key 不可用、完整历史回退、历史已清理时保留本地状态并报错，以及替换快照后的恢复。Core 覆盖打开前、取 key 期间撤销签名者，且历史增量仍可读。受影响检查和可撤回变异结果记录在 PR 中。

已有有限步骤的 core 继续使用原生 Effect。Repo/SDK Promise 集成保留在原有应用 facade；迁移尚未完成的依赖会扩大任务，无法直接改善本次快照边界。

[隔离 Electron 测量](../../../../apps/electron/scripts/e2ee-ipc-benchmark.md) 记录性能与限制。Docker 预检未发现运行中的 daemon（缺少 `~/.orbstack/run/docker.sock`），因此未验证私有 local-stack / 真实 gateway、生产 48 小时 trim 配置、真实 OS 密钥保管、安装包、其他平台或整个工作区启动。本次不包含私有后端改动。

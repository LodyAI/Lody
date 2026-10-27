# PR20-C：换代接收与发送交接

Status: proposed
Translation: current

[English](2026-10-27-e2ee-epoch-receive-barrier.md)

## 摘要

M2 在已验证 epoch 变化时停发，但还不能恢复。PR20-C 接收已提交的暂存信封，将桌面和 CLI
现有房间交给已安装的新代，不替换 Repo、不删除本地队列。逐工作区 gate 拒绝旧 provider
结果，等待实际 SDK 操作收束，确认新钥安装，替换会话后才恢复 seal。失败保持可见且可重试；
撤销和发布动作仍属于 PR20-D。

## 权限与顺序

原生工作区持有已验证账本、已安装密钥及接收 journal。locator 来自真实发布原件，KeyReceiver
重查签名、发布绑定、当前接收资格、HPKE 和 commitment。仅缺少当前密钥时进入 staging。
快照加入缺少该发布原件、以及后来加入而不在该组的设备，仍走 mailbox／历史恢复。服务器
进度从不授予权限。

每个 renderer／CLI 工作区拥有一个 gate 及 Promise SDK 交接。epoch 变化或 rotationRequired
同步停发并退役旧 provider。等待已准入 crypto 与实际房间 I/O 结束后，安装并回读确认当前
钥，建立新 provider／会话，然后恢复 seal。namespace 跨 epoch 保持 genesis 绑定，每次 seal
仍由 core 核对当前权限。旧 transport 回调绑定其代次。

桌面已有内容会话时只先刷新账本；冷启动缺钥时没有旧会话，可以直接安装。renderer 保留
Repo、Mirror、游标及待发数据，重试按钮和重连驱动同一有限尝试。CLI 先恢复本地存储再准入
seal，避免 seal 等 refresh、refresh 的屏障又等同一 seal。上线回调只合并刷新请求，不等待
嵌套换代。

## 实际 SDK 收束

锁定的 streams-crdt 0.19.2 和 loro-repo 0.25.0 关闭订阅时不等待全部实际操作。挂起真实
POST 的实验复现 close 先返回；SDK 代码也证明旧游标仍可能迟到保存。两个同版本 pnpm 补丁
增加显式 drainOnClose，普通传输保留默认 false。

CRDT 退役关闭新准入，持有完整启动／读取／直接操作，并等待它们及稳定的 opQueue 尾部。
Repo 持有所有创建的 stream，包括临时建房，在等待前关闭准入；移除的 stream 直到强关闭
成功才解除持有，并拒绝迟到的会话创建。快照保持禁用。包版本、线算法、签名和持久格式不变。

未把第二次普通 close 当作证明：旧 SDK 失败时也会清空会话表。超时或清空队列均不能证明
实际操作结束；新 opt-in receipt 等待的正是实际工作。

## 故障隔离与迁移

- 触发：已验证换代、启动、重连或显式重试。
- 拥有者：受影响工作区的 gate 和原有原生／transport Scope；不在全局锁等待网络，不另建
  Repo 或重试 daemon。
- 取消：结束等待不代表请求停止。gate 关闭先退役代次再等已准入工作，原生 Scope 继续持有
  crypto。
- 交接：收束、新钥回读及新会话 receipt 全部成功才恢复发送。旧完成事件不能更新后继代次。
- 恢复：drain／install／restart 失败保持停发，在同一拥有者重试。其他工作区照常发送；
  本地数据及签名原件保留，注销／退出仍归原有终止拥有者。

这不是 Repo 消费者的 Effect 迁移。core 接收保持原生 Effect，共享 Legacy gate 只组合
既有 Promise SDK 拥有者。消费者迁移仍按[路线图](2026-09-27-effect-lifecycle-migration-roadmap.md#unit-ledger)
延后，不增加执行 runtime、远端签名回调或密钥导出。

## 证据与限制

新增回归先撤回对应修复确认 RED，再验证 GREEN。受控测试覆盖逐步重试、旧 provider 和
重启结果、工作区挂起时另一工作区发送、冷启动缺钥、发布者 Scope 关闭后的真实 SQLite／
crypto 暂存接收，以及真实 SDK 上传／读取／游标／临时建房收束。真实 Repo／IndexedDB
测试进一步证明挂起加密传输不影响另一工作区发送。受影响检查与独立审查绑定 PR 精确 head。

真实网关到期／长连接、安装后双设备换代、系统钥匙串、跨平台打包及总十五分钟撤权界限
尚未验证，完整仓库测试交 CI。本项只替换[M2 note](2026-10-22-e2ee-m2-product-integration.md)
中的停发限制，不代表 draft Spec 获批或启用 PR20-D。

## 采用与退出边界

两个精确版本补丁都提供能力标记；缺少任一补丁时，加密 transport 拒绝启动。
后续私有外层工作区采用此公开版本时，必须同步镜像两个补丁；嵌套配置不会继承。
换代先使 token 失效再等待关闭，桌面缓存键额外包含 epoch，避免删除未生效时复用旧 token。
若换代已移除 adapter 但 close 失败，退出仍保留并关闭该 owner，再销毁 Repo。

初次同步的 deadline 只结束等待者，原始任务仍归强 close 收束；fake timer 回归覆盖
超时后仍在保存的游标。强 close 也等待 SSE release；release 超时仅返回可重试失败，
保留 owner，不能作为新代次发送许可。真实 SSE cancel fixture 覆盖失败与释放后重试。

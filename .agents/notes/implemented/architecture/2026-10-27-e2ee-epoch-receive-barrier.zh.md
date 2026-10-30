# 当前 epoch 封装与已封装旧帧

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1954

[English](2026-10-27-e2ee-epoch-receive-barrier.md)

## 摘要

新内容由原生 host 在内部选择已验证的当前 epoch 封装。已封装旧密文和历史读取保持可用，但旧 provider 提示不能授权生成新的旧 epoch 密文。

## 权限与选择

原生 host 拥有已验证账本、已安装 key 和接收日志。renderer/CLI 的切换器保持稳定回调，可能暂时保留旧 epoch 提示；提示不构成加密权限。每次新 seal 都在原生操作内部由 core 的 `writeEpoch: current` 选择 epoch。缺当前 key 时保存失败并等待重试，绝不换用旧 key。文档、Meta、Flock 的 update 和 snapshot 遵守同一规则。保留历史数据的本地副本仍可打开。

换代前已经捕获 epoch 的操作可以完成旧帧，队列中已经封装的旧密文也可继续发送。这两种情况均不允许把新内容封装为旧 epoch。历史 key 和原始密文保持不变。每次操作仍在加密前及签名后执行 core 的当前成员/设备检查；被撤销、被移除、Guest 和 Recovery 写入者仍被拒绝。namespace、commitment 和帧格式均不变。

以前的可用性优先 MVP 明确允许接收新 key 时继续用旧的已发布 epoch 封装新内容。该取舍被上述安全要求覆盖：被撤销设备可能保留旧 key，服务端凭据过期不能证明新内容的机密性。另一个窗口或原生操作可以在不通知已有 renderer 的情况下完成换代；依赖其缓存 epoch，即使新 key 已安装也会继续泄露新内容。原生每次操作选择 epoch 也避免了读取 status 后再 seal 的竞态，不在保存队列中新增网络请求。

## 接收与失败隔离

staging locator 来自真实 publication 原件。KeyReceiver 独立验证签名、publication、接收者、HPKE 和 commitment。可选 staging 拒绝或 I/O 失败不阻断独立验证的 mailbox/history 接收；读取失败不算安装成功。没有自动签署、替换 key、明文回退或破坏性回滚。

已有 renderer/CLI owner 在启动、已验证换代、重连或显式重试时启动接收。十秒等待超时仍保留未完成原生工作的 owner；迟到、超时或被替代的回执不能提交 UI/token 选择。关闭退役回调并等待已接收的 crypto 和原始工作。独立工作区互不阻塞。当前 key 读回后同步推进切换器并使活跃 token 失效；未来桌面 token owner 按 epoch 区分缓存。`rotationRequired` 仍只提示管理员手动操作，不代表 publication 或权限判断。

无需重启 Repo、替换 transport、删除队列、SDK strong-close 补丁或升级 SDK。缺 key 或存储失败让 SDK 保存立即失败，本地数据保留供重试；保存队列不等待网络接收 key。旧 key 保证历史可读，不授权生成新的旧 epoch 密文。

## 证据与限制

确定性测试覆盖真实稳定桌面 provider 与原生 SQLite/crypto host：撤销并换代而未通知 renderer、文档/Meta 的 update 与 snapshot、缺当前 key 的拒绝、历史读取，以及回执/关闭所有权。已有接收测试保留 staging 拒绝、临时 I/O、mailbox 延迟、晚加入 machine、重启和 candidate 恢复。这些是本地边界检查，不是安装设备、OS keychain、gateway/WAN 或跨平台验收。

此前的 advisory 权限改动独立审查于 [#1956](https://github.com/LodyAI/Lody/pull/1956)。原生 Effect consumer 迁移仍由[路线图](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md#unit-ledger)单独跟踪。

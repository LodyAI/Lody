# 手动密钥更新与设备撤销

Status: proposed
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1980

[English](2026-10-27-e2ee-manual-key-management.md)

## 摘要

Owner 为可用性优先的 MVP 选择了管理员手动更新密钥。加密工作区设置提供设备撤销和醒目的更新按钮，合格管理员设备的设置入口显示小红点。撤销复用签名账本命令和服务端投影；换代失败保留可用的旧 epoch 和本地编辑。Candidate、submission 与 round 的持久化恢复，使普通重试、确认丢失和单轮暂存名额满均不要求替换签名。此实现仍为草稿，安装设备和网关撤销验收另行完成。

## 边界

管理操作留在桌面 main。Renderer 只得到已验证的公开设备事实，以及固定目的的更新／撤销 IPC；密钥、任意签署和后端凭据不进入界面。资格和撤销目标来自真实账本，core 在签署时再次检查。普通／本地工作区保留原设置，不构造管理操作；其他工作区拥有独立存储和操作 owner。

设置提示在 custody 锁外刷新账本，离线时保留已验证事实，只通知同账号、同工作区的内容 owner。手动成功后也立即读回原生状态并选择新钥；若已安装，无须再等待 mailbox。没有关闭房间、transport 或清空本地队列；迟到结果继续按账号／工作区生命周期丢弃。

## 持久化继续流程

EpochPublisher 先保存 candidate，暂存完整信封组并精确读回，再经 LedgerSubmission 提交。独立 candidate／submission SQLite 文件按工作区和签名公钥隔离。即使账本已清除 rotationRequired，未完成结果仍显示继续入口，先恢复安装和确认，再允许新签署。

Candidate 丢失时，只有真实账本已证明提交或冲突，才对账同一 submission 原件；parent 尚未变化时，不能在缺少 candidate 的情况下发 CAS。释放结果必须证明真实 feed 包含已观察 checkpoint；Committed 还要求对应 epoch 密钥已验证安装。正常 staging／mailbox 接收可独立安装已提交密钥，不依赖损坏的 candidate blob；已安装历史还可恢复更早的未决密钥。未发布 candidate 不绕过 CandidateProtector。无法验证的证据继续保留，提供个人设备授权的直接入口或提示另一台合格管理员设备；后续真实冲突可释放旧 submission，不重签原记录，也不静默删除日志。

Round 只是签名字节之外的计数元数据。原生 history 数据库中的按 record hash 查询表在发送前持久化随机 round，重试和重启复用。只有验证过的独立名额满错误才允许持久化新 round，并在同一目标 epoch 重试同一不可变 candidate。每次点击最多暂存两次；新轮仍满时继续保留可重试入口，不跳过 epoch，也不限制轮数。未知结果不会另造 candidate 或 round。本改动扩展本地计数存储，不回退账本、snapshot、retained／digest v3、candidate 保护或信封格式。

## 失败隔离与证据

启动和状态查询不签署换代。用户操作拥有有限次尝试。原生工作区负责管理刷新、ingest 和接钥，不重新进入账号锁，也不从管理操作里等待关闭自身；账号／工作区关闭会取消网络并等待该操作，再释放原生资源。失败保留原件和旧发送 epoch。原始 Cause 留在 main，界面给出重试、管理员设备、身份恢复或维护者诊断提示。服务端继续验证撤销凭据；本客户端不收回已签发的网关 JWT，沿用 owner 接受的 MVP 绝对有效期。

确定性回归使用真实 SQLite／加密和 SDK 请求、明确的存储失败与信号，覆盖暂存失败和多轮名额满后的重启、candidate 损坏、提交后安装失败、终态确认、旧 epoch 发送、仅手动签署、迟到界面结果及账号／工作区通知隔离。新增行为均撤回修复先 RED，再 GREEN；Storybook 展示真实设置组件和恢复状态。本地检查不代表真机／钥匙串、跨平台打包、已部署 Convex／网关或端到端撤销验收。

此实现接续 [MVP 决定](2026-10-27-e2ee-mvp-manual-rotation.zh.md) 留给 20-D 的手动入口，并组合 [不停发的换代接收](2026-10-27-e2ee-epoch-receive-barrier.zh.md)。没有自动换代签署或破坏性 fallback。

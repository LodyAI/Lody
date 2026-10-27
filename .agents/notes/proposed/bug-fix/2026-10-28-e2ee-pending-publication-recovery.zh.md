# 未决 epoch 提交恢复不再依赖暂存可用性

Status: proposed
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1987

[English](2026-10-28-e2ee-pending-publication-recovery.md)

## 摘要

未知 epoch CAS 在已验证账本仍停留于 parent 时，会再次经过暂存；随后暂存故障就能阻挡原本健康的设备撤销。EpochPublisher 现在直接恢复匹配的持久 submission，保留完全相同的签名字节、安装验证和确认要求。首次提交仍需完整暂存并精确读回，不改变格式、签名者或资源所有权边界。

## 恢复边界

Publisher 先持久化 candidate、暂存完整信封组并精确读回，再创建 submission 日志项。恢复先比较日志原件与已校验 candidate 的记录字节；匹配后直接恢复 LedgerSubmission，不重复暂存 I/O。日志只是执行顺序的凭据，不是账本权限。成功与确认前仍要求真实账本绑定和已安装密钥验证；未知 CAS 保留原件，不能据此重新签名。

没有匹配 submission 的 candidate，在首次 CAS 前仍须暂存／读回。独立撤销按既有[手动管理决定](../architecture/2026-10-27-e2ee-manual-key-management.zh.md)可绕过这种仅本地 candidate。Core publisher 继续负责恢复，沿用宿主已有的 scope 接纳与 drain，不新增后台所有者或重试循环。成员移除调用方可直接复用，无须另造 signer 或日志。

## 证据与限制

既有原生 SQLite／加密撤销回归现覆盖：CAS 结果丢失后重开宿主，再让暂存写入和读取同时失败。测试确认未知 CAS 仍保留原件；CAS 恢复健康后，在暂存仍不可用时完成同一换代的安装／确认并提交撤销。修复前因重复暂存失败，修复后通过。只有 candidate 的失败分支继续验证首次提交的前置检查。测试使用合成 custody 与远程端口，不代表已部署服务或真实系统钥匙串验收。

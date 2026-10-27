# 已入日志的换代原件恢复不再重复暂存

Status: proposed
Translation: current

[English](2026-10-28-e2ee-journaled-publication-recovery.md)

## 摘要

完整换代组已经暂存并精确读回后，CAS 仍可能在原 parent 处结果未知。`EpochPublisher.resume` 再次暂存会让后来发生的暂存故障阻塞设备撤销和成员移除；提交日志已经保留通过首次暂存门槛的同一 publication 原件。

## 决定

只有尚无匹配 journal 原件的 candidate 才重复暂存/回读。匹配原件直接恢复账本对账与 CAS，CandidateProtector 的载荷/承诺核对、原 parent 授权、真实检查点/安装证明和确认条件不变。未发布 candidate 缺失时仍不得在原 parent 发 CAS。不重签、不丢日志、不改 wire 或存储格式。

既有 workspace Scope、管理接纳和普通提交日志继续负责取消、原生运行与关闭。账本恢复失败保留原件重试，成功后安装真实已提交密钥并确认，再为下一条普通命令签名。管理器保留独立修复已提交密钥的现有路径。原生成员移除和撤销共用 `host.manage`；只将产品工作中的内部移除命令/类型前移，让两条真实入口都有回归。成员 UI/IPC 与本地数据删除保持独立。该单元已有原生 Effect v4，不引入新迁移、拥有者或重试循环。

## 证据与限制

真实 crypto/SQLite 回归在 publisher 修补前为 RED：重开后 CAS 未知、暂存服务故障时，原生撤销和成员移除均失败。Core 回归禁用签名器并使暂存/回读失败，核对原字节提交、密钥安装和确认。原生用例还覆盖旧代密钥缺失、尚未提交 candidate、CAS 持续不可用、原件保持，以及最终成员/设备状态改变；保留已有 candidate 缺失/损坏、冲突和安装重试覆盖。收钥顺序的撤回实验仍为 GREEN，证明该额外重构不是本次修补所需，因此不包含它。

最终受影响检查与 CI 记录在 PR；不代表真实钥匙串、多设备安装或线上暂存/gateway 验收。未合入、部署或采用私有 gitlink。

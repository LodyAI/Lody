# E2EE 未决契约与未完成集成

Status: proposed
Translation: current

[English](2026-10-15-e2ee-open-contracts.md)

## 摘要

当前公开消费者没有完成白皮书全部行为，也没有建立生产 E2EE。未定决定保留在已有 draft Spec 中，不在每张 PR 的 Note 里重复拟议字段；缺失的接线与需要人类批准的决定分开记录。[当前决策记录](../../implemented/architecture/2026-10-15-e2ee-current-decisions.zh.md) 不批准下面任何选项。

## 需要审议的决定

| 归属                                                                        | 未定边界                                                                                                                                                                                                  |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [原子移除](../../../../specs/e2ee/atomic-removal.zh.md)                     | tag8 编码与先暂存后 CAS 方向已定；修订的 Spec 仍 draft 待审。不需要旧客户端 capability 或降级读取。                                                                                                       |
| [Recovery vault](../../../../specs/e2ee/recovery-vault.zh.md)               | vault-v1 包装、不可变上传／索引 CAS、保留及可续跑恢复已选定并实现；修订 Spec 保持 draft 待审批。合法旧密文不证明最新状态。                                                                                |
| [发布者可恢复性](../../../../specs/e2ee/publisher-key-recoverability.zh.md) | 旧备份 A/B 选项已被整组信封先暂存后 CAS 替代。已提交组可在发布者磁盘丢失后恢复；不遵守协议的管理者仍可扣留钥。vault 和管理身份恢复仍独立。                                                                |
| Snapshot 与 checkpoint 信任                                                 | 已选的 content-v0 快照字段认证 continuation 位置，且有耐久原件接纳参考实现；邀请人钉住的权限快照加入已选定并实现，其他生产当前 checkpoint 来源另行处理。已有 update binding 或 SQL cache 不提供这些保证。 |
| 其他产品/协议范围                                                           | Installed-history 产品启用、签名比较 notes 与严格期限 B 仍独立。Replay 已重执行原始输入，不增加 core 熵接口；首次 seal 的安全随机和普通容忍未变。                                                         |

## 尚未完成的集成

[loro-streams#421](https://github.com/loro-dev/loro-streams/pull/421) 发布后，升级 Lab 的
SQLite 依赖并删除 `patches/@loro-dev__sqlite-riverrun@0.3.0.patch`。这个临时补丁直接修改
已发布的 dist 文件，不作为永久分支维护。

逐项去向归 [manifest](https://github.com/LodyAI/Lody/blob/5f97599e60700d6185834632df85922ea0d73ec6/.agents/docs/e2ee-migration-manifest.json)。剩余是生产新鲜度／资格取得、有权限的历史保留读取、机器执行和其他产品消费者、实际 OS 钥匙串／平台验收与产品组装；桌面主进程保护器已实现但未启用。当前创建／宿主恢复、暂存发布、有限模型动作计划及原输入重放已实现，缺测明确为未测。教程只有 Spec，没有已迁应用源码。这些缺口并非全是新协议决定；已定工作可以推进，不能发明未定部分。

本文不选择待定方案。Note、来源清单、合成测试或祖先 READY/CI，都不能代替人类批准或生产验收。

# 发布者密钥可用性：先暂存再提交

Status: approved · [批准记录](../../.agents/notes/implemented/architecture/2026-10-28-e2ee-spec-approval.zh.md)
Translation: current

[English](publisher-key-recoverability.md)

原独立备份 A/B 两方案作废，采用用户选定的[先暂存后提交](atomic-removal.zh.md)。
诚实发布者先持久保存受保护候选、原始签名记录和换代后全部接收者的信封，再一次
暂存整组、读回精确核对，最后发 CAS。

CAS 前崩溃重启沿用同一原件和暂存组；丢 ACK 按 P09 原字节对账；冲突使候选
作废，不安装或重签。提交成功后其他设备不依赖发布者磁盘即可取得暂存信封，
因此发布者永久丢失也不会造成诚实流程里“已提交但尚未分发”的窗口，无需跨
Convex/Streams 事务。

仍依赖暂存服务保留并交付已确认原件，也依赖发布者生成可解密信封。绕过暂存
直接 CAS 是 Lab 必测的恶意管理者扣钥情况。同 epoch 被另一个真实 commitment
占用，诚实客户端才允许请求清理。适配器另须确认删除者就是 R 的原签名设备，其他成员
或管理设备的 occupied 声明不能授权删组。恶意发布者删除自己的组仍属于已知扣钥限制。后来加入的设备走普通 mailbox/repair。AEAD 不证明最新或无法扣留。

Restricted A 仍只指已安装密钥的宿主保护，不是 vault 或身份恢复。本决定不增加
紧急移除例外、账号后门、vault 包装/保留策略或严格 B。修订稿于 2026-10-28 获批；原生
protector 和私有产品启用另行验收。

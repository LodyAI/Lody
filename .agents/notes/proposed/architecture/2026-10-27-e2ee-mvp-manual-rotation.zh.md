# MVP 手动换代保持发送可用

Status: proposed
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1956

[English](2026-10-27-e2ee-mvp-manual-rotation.md)

## 摘要

Owner 明确以可用性优先的 MVP 决定覆盖强制换代停发方案。已验证账本中的 rotationRequired 保留为管理员手动操作提示，活跃的非 Guest 个人／机器设备继续具有封装权限。被撤销设备、已移除成员、Guest 和 Recovery 仍不能写。此取舍接受被撤销设备持有当前密钥时仍能解开它获取的密文；访问边界由服务端凭据／token 权限和绝对过期承担。

## 范围与证据

只修改派生的内容权限，不修改账本原件、保留状态、快照、commitment、签名域或线格式。既有真实 replay 测试覆盖换代前后和被撤销设备，真实 Streams 加密／准入测试覆盖待换代时继续生成可用密文。两项改写行为均在旧实现上先失败；当前成员检查和签名后复查保留。原生 CLI 与真实 HTTP Lab 的消费者测试也验证待换代时可用的封装，撤销写者仍被拒绝。

固定 epoch 的文档绑定交接由独立 PR20-C 负责。此 PR 不增加自动签署、撤销 UI、设置红点或 release。真实网关过期与安装设备验收仍未验证。此 owner 决定覆盖旧文档对停发的解释，不回退任何已保存格式。

# 临时跳过会话全状态校验

Status: draft
Translation: current

[English](session-validation-hotfix.md)

合法消息不应因无关旧历史的全状态校验而被拒绝。作为临时的可用性取舍，渲染端和 CLI
的会话 Mirror 跳过更新校验，其他文档校验和外部输入解析保持不变。这不保证 malformed
本地写入会被拒绝，不让旧消息自动变得可渲染，也不授权迁移历史。

此处接受只表示本地 CRDT 更新，不代表成功落盘、Agent 执行或远端送达。
writer 替换仍需单独审查（#460）；通过局部输入校验恢复保护，不重新让旧历史阻断发送。
未更新的客户端仍保持旧行为。

证据：`packages/shared/tests/session-validation-hotfix.test.ts` 和
`mirror-construction-sites.test.ts`。不声称已完成发布端验收。
本文件为待人工审查的草稿，测试不构成批准。

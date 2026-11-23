# 分享 Prompt 跟随访客语言

Status: implemented
Translation: current

[English](2026-09-13-share-prompt-language.md)

## 摘要

分享页已有语言切换，固定英文的复制 Prompt 不再与界面一致。
按需求改用同一个 i18n 实例生成 Prompt。静态客户端返回已校验的访问元信息，
访客界面负责翻译文案。授权和过期规则保持不变。

此决定仅替代[静态分享提案](../../proposed/architecture/2026-09-12-static-session-sharing.md)
中的固定英文策略。若在传输客户端维护翻译，会重复界面的语言规则，
因此 `createAgentAccess` 改为返回已校验 URL 和过期时间。
中英文模板保留相同的“仅供参考”“禁止转发给无关服务”及过期提示。
纯文本插值不能对访问 URL 做 HTML 转义。

访客测试覆盖切换语言前后的复制，传输测试保留固定版本授权和外域 URL 拒绝覆盖。
本次文案改动未重跑托管端到端签发流程。[Spec](../../../../specs/session-sharing.md)
仍是草案，此记录不代表批准完整分享切换。

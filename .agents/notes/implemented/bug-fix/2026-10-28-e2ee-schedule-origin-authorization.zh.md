# 将加密定时任务执行绑定到原始签名者

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/2012, https://github.com/LodyAI/Lody/pull/2018

[English](2026-10-28-e2ee-schedule-origin-authorization.md)

## 摘要

可写的定时任务 owner 字段不能授予执行权限。其他成员原先能伪造这个字段和注册表 fingerprint，再让目标机器把攻击提示词变成机器签名的用户 turn。加密定时任务写入现在附带 CRDT 声明，声明里带有设定人对实际执行 fingerprint 的签名。定时任务交接和共用的实际启动 claim 都根据声明的已验签设备，调用现有机器访问检查。账本与普通工作区行为不变。

## 决定

只有加密写入会向 Loro 列表 `scheduleAuthorizations` 追加 map。定义声明包含 `kind: definition` 和 `definitionFingerprint`；手动运行声明使用 `kind: manual`，并包含稳定的 `manualRunKey`。记录中的身份字段不能授予权限。自 owner 2026-11-10 决定起，每个声明都在同一次提交里带有设定人对定义指纹的签名执行意图（[签名的执行意图](../architecture/2026-11-10-e2ee-signed-execution-intent.zh.md)）；启动时从当前文档重新计算指纹并验证这份签名，不涉及更新帧、重建或 `forkAt`。用户明确保存时会创建新声明；单纯追加 timeline 活动不会使其失效，同值改写也不改变要执行的内容。

每次调用都根据当前已验证 signer 执行现有的认证机器访问策略，并检查等待授权期间文档是否变化。手动运行同时要求定义和请求的 signer 获得授权。注册表行仍只负责发现和发布门控，不授予权限。

A3 装配中，定义与手动请求的签发者都经过普通执行使用的机器／项目共享门。交付前检查已签名定义的本地项目；实际开始使用宿主解析的 Session 目标，包括明确的纯聊天无项目状态。所有来源授权检查与生成 turn 的检查取交集，保留到同步 journal claim 前。后一个签发者的认证刷新即使没有权限变化，也可能使较早的账本快照失效；因此来源检查最多通过已填充的 requester 缓存再检查一次，随后复查 turn 签发者。不稳定或已撤回的结果仍拒绝 claim，合法多设备 schedule 则保持可用。

机器生成的加密 turn 在 `scheduleRun` 中冻结 fingerprint 和可选的手动运行 key，机器对该 turn 的签名执行意图覆盖这些字段。实际启动 journal claim 会再次独立验证定时任务授权，因此缓存的准备结果、已提交的派发指针和机器自己的签名都不能替代输入来源授权。缺少声明或签名时确定拒绝并给出原因。签名属于文档状态，所以仅从快照启动的副本也能授权同一声明。快照作者不能授权历史定时任务输入。

## 证据与限制

`apps/cli/tests/e2ee-runtime.test.ts` 的对抗夹具使用真实的其他账本成员、带签名的加密定时任务及注册表，以及 SQLite 规划状态，验证在准备前拒绝攻击。它还验证缺少来源授权或执行前被篡改时实际启动失败。相关用例覆盖目标、规则和提示词修改、同值改写、仅有快照、手动请求及授权期间的修改。这些夹具不证明已部署或打包后的多设备验收。

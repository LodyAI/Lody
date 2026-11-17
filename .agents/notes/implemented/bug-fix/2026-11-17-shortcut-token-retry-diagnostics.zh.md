# Shortcut 令牌重试诊断

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/2836

[English](2026-11-17-shortcut-token-retry-diagnostics.md)

## 摘要

Shortcut 的令牌 action 和内部授权 query 曾分别产生服务端异常，重试又继续增加摄入量。
V2 对已处理失败返回固定结果，由 Shortcut provider 按资源、读写方式、故障码和阶段
在成功前只报告首份诊断。失败仍交给调用方，认证拒绝通知已有 supervisor。
未知平台故障和旧客户端保持原有上报行为。

## 所有权与兼容

provider effect 绑定账号、认证会话、workspace 和操作。refetch 期间短暂无 session 保留同账号最后确认的 owner。退役后旧回调不能上报；
更早请求的迟到成功不能清空较新故障。次数只存在内存中，不变成 analytics、认证缓存、
repo meta 或持久状态。不同故障码、阶段、状态和操作仍保留首份诊断，成功只清空本操作。

已处理错误带专用类型，deferred reporter、SDK `before_send` 和 React boundary
不会重复上报。认证错误保留已有 ConvexError 的名称、symbol 和 data 合同。Streams 刷新保留 auth-provider 的原始 cause，不将已处理失败重新包成通用异常。
首份诊断只含固定故障码，在受限遥测范围也遵守
[隐私投影](2026-10-29-workspace-telemetry-privacy.zh.md)，不改变授权规则。

先部署新增后端 V2，再发布客户端；V1 的成功 Token 和抛错合同保留。
新客户端只在明确缺少 V2 时协商使用 V1，这不是权限缓存。
旧客户端和旧后端兼容路径仍可能逐次计费。不按时间或文本在后端合并：
未认证请求没有可信重试身份，不能吞掉独立故障。

只有整条 cause 都属于已处理 Shortcut 失败时才跳过 boundary/deferred 上报。混合或外部 cause 保留独立的固定 boundary 诊断；较早的已处理令牌失败不会消耗 boundary 的本轮预算。浏览器测试保留 Shortcut/boundary 的 script SDK 与 sync-stuck ESM fixture 的独立模式。

## 证据与边界

有限模型检查五种事件、深度七内的 78,125 条序列；实现检查覆盖 100 次尝试、owner
退役、独立故障、认证恢复、旧接口协商和换票后撤权。锁定的真实浏览器 SDK 向本地接收端
发送事件，以实际接收数量验证。处理函数测试不能证明托管 Convex 的集成交付。
处理函数外超时和更深层 component 失败仍可能自动采集；不修改全局压制或生产配置。
不自动重放失败写入。

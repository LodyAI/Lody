# 保留没有消息阶段标记的 Codex 标题回答

Status: implemented
Translation: current

[English](2026-10-15-codex-title-optional-phase.md)

## 摘要

已配置的 Codex 标题模型可能正常返回标题，却因缺少 `final_answer` 标记而被 Lody
丢弃。Codex 协议明确允许阶段未知，因此不能用标记缺失判断回答失败。标题收集器现在
接受没有阶段标记的正文，并在存在明确最终回答时优先使用它。明确的 commentary、
提示发送前的输出、错误载荷及失败请求仍不会成为标题。此次修复不改变保存的模型选择
或 Provider 鉴权，也不证明任何实际接口的可用性。

## 决策与证据

本修复补充[客户端拥有 Codex 标题生成](../architecture/2026-10-10-codex-client-titles.zh.md)。
适配器生成的 `MessagePhase` 契约要求兼容未知阶段，事件处理器也保留标记缺失的状态。
Lody 此前要求每个 Codex 文本块都有 `final_answer`；成功的 ACP prompt 返回值只有完成
元数据，没有回答正文，因此无法从返回值恢复被丢弃的标题。

分别缓存明确最终回答和无标记正文，优先选择前者，避免与无法分类的中间文本拼接。
启动及配置完成、发送标题提示之前清空两个缓存。对选定的完整文本执行清理，确保分块
错误载荷也被拒绝。明确的 commentary 仍被排除。鉴权、标题配置校验、请求失败回退
及进程清理保持现有责任划分和行为。

本修复限于普通输出处理。辅助 ACP 生命周期迁移会涉及尚未完成迁移的进程和启动依赖，
依据 Effect 选择指南推迟，本次不声称完成原生迁移。

## 验证

现有测试套件覆盖保存的自定义标题模型与合成环境变量、无标记及分块回答、明确的
commentary、最终回答优先、启动及配置输出、分块错误和部分输出后的请求失败。
在使用锁定依赖的独立克隆中，两个标题测试套件及标题写回套件共 33 项测试通过，CLI
类型检查和局部 Oxfmt、Oxlint 检查通过。仅将实现换回 HEAD 后，自定义模型回归测试
复现问题：返回 `Original task` 而不是 `Custom endpoint title`。
文档检查报告六处指向未初始化 Kimi/Pi 子模块的既有链接问题，均与本次改动无关。
全仓库 `pnpm format` 通过。`pnpm check` 通过全仓库类型检查与 lint，随后在未改动的
`github-git-transport.test.ts` 递归 SSH 子模块测试处停止：宿主凭据桥报告
`context_unreadable`。CLI 共 4270 项测试通过、1 项失败、4 项跳过，后续串联检查未执行。
未调用真实模型接口。

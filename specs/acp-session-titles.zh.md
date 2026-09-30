# ACP 负责 Session 标题

Status: draft
Translation: current

[English](acp-session-titles.md)

Provider 自行生成 Session 标题时，Lody 不应为同一工作再启动 ACP 进程。
Provider 通过 Core 初始化能力
`agentCapabilities._meta.lody.sessionTitle: { version: 1 }` 声明接管。

主 Session 完成初始化后才判断标题归属。实时能力适用于 builtin、registry、custom
Provider 及运行时覆盖，即使尚无探测缓存也生效。旧版托管 Claude/Codex/Grok
继续使用身份兼容名单；运行时覆盖禁用该兼容路径。其他运行时保留独立生成。

Provider 推送标准 `session_info_update`，包含 `title` 和 `_meta.lody.titleSource`。
`generated` 需要声明能力；`explicit` 保留兼容接收。拒绝 `fallback`、`unset`、
无效来源标签、空标题以及其他 ACP Session 的通知。仅旧版 Claude/Grok 接收无标签标题。
Lody 清理标题内容，只更新 draft/generated 标题，保留用户手动命名。
Provider 生成失败时保留草稿标题，不通过超时启动重复生成器。

能力探测和正常 Session 初始化将支持标志持久化到各 Provider 的缓存。
设置页面在匹配的能力数据表明 Provider 接管标题时隐藏独立生成选项，仍检查
自定义命令和运行时覆盖的来源匹配。缓存版本仅影响刷新，不影响已知字段可读性；
执行时以实时初始化结果为准。

## 证据

- [Core](../packages/acp-extension-core/README.md#automatic-session-titles)
- [CLI 实现](../apps/cli/src/agent/README.md#session-titles)

# 切换模型时保留继承的权限选项

Status: implemented
Translation: current

[English](2026-10-16-inherited-permission-option.md)

## 摘要

Grok 等 agent 把权限策略放在 `_permission` 配置选项（`permission_mode`）里，而不是
`modeId`。CLI 或 MCP 的后续消息切换模型，或只传入部分配置选项时，派发解析会整组替换
继承的配置表，把 “Always Approve” 静默丢掉，这一轮于是按 Grok 默认的 “Ask Every
Time” 运行。现在解析把 `_permission` 和 `mode` 类别的选项视为与模型无关：切换模型时
保留，在部分显式配置下合并；effort 和 Fast 仍按模型处理。使用 `modeId` 的 agent
（Claude、Codex）不受影响。

## 决策与证据

`resolveEffectiveSessionChatDispatchConfig` 在请求的 `modelId` 与上一轮不同时丢弃
`previous.configOptionValues`，因为 effort 和 Fast 属于单个模型。权限并不依赖模型，
但 Grok 的权限恰好在同一张表里。`mergeTurnDispatchConfig` 也会用任意显式配置表整组
替换继承的表，所以只传 `--config-option web_search=false` 同样会重置权限。从 opener
创建 Session 共用这段合并逻辑。

只有能力目录标为 `_permission` 或 `mode` 的选项会被保留。没有能力目录时不额外保留：
这条路径无法区分权限选项和依赖模型的选项。显式值仍覆盖继承值；显式 `modeId` 仍会移除
继承的 `mode` 选项（`removeShadowedInheritedSelectors`）。

Role 发现有一个相关缺陷：它查找 _id_ 为 `_permission` 的选项，并读取
`configOptionValues._permission`，因此固定了已下线 Grok `permission_mode` 值的
Role 仍显示为可用。现在 `modeId` 对照 modes 或 `mode` 选项检查，每个 `_permission`
固定值对照它自己的选项检查。

## 本次未修复

Claude 适配器以 root 身份运行且不在沙箱中，或设置了 `disableBypassPermissionsMode`
时，会从模式目录中移除 `bypassPermissions`。Lody 的 Claude 静态目录仍列出 Bypass，
所以选择会被拒绝并给出配置警告，会话停在 Manual。这需要另外决定静态目录如何反映探测到的
限制。

## 验证

`apps/cli/src/commands/session.test.ts` 用 Grok 形态的目录覆盖了切换模型、部分覆盖和
显式覆盖；切换模型的用例在未修复时失败。`apps/cli/src/lib/resource-discovery.test.ts`
覆盖了有效和已下线的 `permission_mode` Role 固定值。没有运行真实 Grok 会话。

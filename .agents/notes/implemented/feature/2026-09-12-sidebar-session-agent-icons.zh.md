# 侧边栏 Session Agent 图标

Status: implemented
Translation: current

[English](2026-09-12-sidebar-session-agent-icons.md)

## 摘要

从不同 coding agent 批量导入的 Session 在标题相似时无法在侧边栏中快速区分。现在侧边栏行模型会保留 Session 的 ACP agent 身份，并在 Workspace、Local Project、Updated 和 Pinned 行的标题前显示现有 agent 图标。图标是被动身份信息，不会占用尾部的工作中、权限等待或未读状态槽；缺少 agent 元数据的旧测试或合成行仍可正常渲染，只是不显示图标。

## 决策

复用现有 `AgentIcon` 映射，不创建侧边栏专用图标资产。通过纯侧边栏视图模型传递 `cliType` 和 `agentType`，让导入历史与实时 Session 使用相同渲染路径。

共享行组件在标题前使用固定 12px 槽位显示图标。作者头像和置顶状态仍表达各自独立信息，原有尾部状态优先级保持不变。

## 备选方案

仅在 hover 信息中显示 agent 可以保持原行不变，但无法满足批量导入的扫描场景：用户仍需逐项打开菜单才能区分 Claude、Codex 等 Session。也不使用尾部状态位置，因为那会在 Session 运行或等待权限时隐藏 agent 身份。

## 验证

定向组件测试覆盖 agent 身份在模型中的传递，以及 grouped 与 Updated 两种列表的渲染。类型检查和仓库检查覆盖直接读取 `SessionMeta` 的 Local Project 路径。

## 限制

行模型只携带持久化的 ACP 身份。如果 provider 品牌覆盖仅存在于当前机器配置而侧边栏模型无法读取该配置，则继续显示该 ACP agent 的通用图标。

# 独立 Plan 开关保留角色选择

Status: implemented
Translation: current

[English](2026-10-17-plan-toggle-role-selection.md)

## 摘要

关闭 Codex Plan 会解除已选角色，因为输入框对角色保存的所有选项执行严格比较。
执行计划入口也会通过同一比较清空角色元数据。现在独立 Plan 作为角色初始值的
单轮覆盖，保留角色身份与记忆绑定。模型、推理、权限及机器绑定仍严格匹配，
包括以权限模式实现的 Plan。

## 决策与职责

`composer-agent-roles.ts` 统一负责新会话、已有会话及程序化消息最终覆盖的匹配。
允许 `plan_mode` 在有效布尔值之间切换，兼容旧 `collaboration_mode` 的
default/plan 切换。缺失或非法值仍不匹配，防止能力回退静默保留失效预设。
重新选择角色仍应用其保存的 Plan 值，不改写角色目录或会话创建来源。
实际消息配置仍决定执行行为，角色快照记录所选预设。

继续要求 Plan 完全一致会迫使用户重选角色，并恢复刚刚关闭的 Plan；忽略所有
选项又会掩盖模型或权限漂移，因此只为独立 Plan 增加例外。
现有[运行配置说明](../../../docs/sessions-run-config.md)已记录此匹配例外。

## 验证

在现有匹配函数和 Hook 测试中补充两种 Plan 表示、执行计划元数据、缺失及非法值、
其他配置漂移、记忆保留、导航及显式 None 的回归覆盖。三个相关测试套件共 40 项
测试及组件类型检查通过。局部 lint 无错误，存在两条原有可空字符串警告；文档
检查通过，仍有原有文件大小警告。完整 `pnpm check` 通过类型检查、lint、Effect
lint 和脚本测试后，在未修改的 CLI 递归 SSH 子模块测试中遇到
`context_unreadable`（CLI 测试 4,310 项通过、1 项失败、4 项跳过），后续阶段未运行。
`pnpm format` 通过。未进行打包客户端界面验收。

# Bub provider 能力验证

Status: draft
Translation: current

[English](bub-provider-verification.md)

添加 Bub 时，用户可以在配置窗口中主动测试 ACP 能力。测试在选定机器上启动持久化的
provider 设置任务，并在窗口中显示进度。验证成功后添加 provider 并提供刷新按钮；
失败时不发布配置，保留重试入口。创建按钮继续通过同一设置流程在后台完成验证。

设置任务尚未完成时，提交的配置保持固定。用户可以重试或删除设置任务；删除后返回
可编辑表单。关闭窗口后，持久化任务仍可在 provider 列表中操作。不支持 provider-setup
协议的机器不能启动这个创建流程。

缺少 Bub 或 ACP 插件时显示安装说明、可复制的安装命令和安装指南链接。Lody 不自动
安装 Bub。已有 provider 可以刷新能力；刷新失败时保留错误信息并提供相同安装指南。
重试成功后清除安装提示。

## 依据

- [配置窗口](../packages/components/src/components/settings/agent-config-dialog.tsx)
- [恢复操作](../packages/components/src/components/settings/provider-setup-row.tsx)
- [行为测试](../packages/components/tests/agent-config-dialog.test.tsx)
- [决策记录](../.agents/notes/implemented/feature/2026-09-16-bub-capability-test.md)

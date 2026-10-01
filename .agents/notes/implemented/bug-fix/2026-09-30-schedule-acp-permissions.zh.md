# 支持没有权限控制的 ACP provider 创建定时任务

Status: implemented
Translation: current

[English](2026-09-30-schedule-acp-permissions.md)

## 摘要

Pi 没有权限选择器，但定时任务此前在编辑器、守护进程创建和交接时都要求明确权限值。现已移除这些重复检查：输入框本身显示默认值，运行时校验由常规会话和 provider 配置负责。定时任务不再为了这道额外检查要求权限值或能力缓存。所有权、目标会话和凭据约束保持不变。

## 决策与依据

锁定的 Pi 适配器（`693d6964`）只返回模型和思考强度控制，因此原先统一的
定时任务权限检查使 Pi 无法使用。按用户澄清，直接删除这道检查，不再改成基于
provider 能力的例外。删除共享判断函数、三个调用点、无用的能力读取和已废弃
的显式选择提示，保留输入框默认值和常规会话执行配置校验。

本次更新了[原定时任务决策](../feature/2026-09-24-machine-owned-scheduled-tasks.zh.md)。
当前行为见[草案 Spec](../../../../specs/scheduled-task-permissions.zh.md)。
保留历史 `PERMISSION_UNAVAILABLE` 翻译，以便已有日志继续可读。

## 验证与限制

测试覆盖不填权限值或没有能力缓存时保存、默认值填充、凭据排除、CLI 命令及
交接行为。不发送真实定时任务提示词。65 项相关测试、shared/components/CLI
类型检查、改动文件格式与 lint、i18n 检查均通过。`docs check` 仍有未初始化的
Kimi 子模块所涉及的 4 处既有断链。`pnpm format` 通过。全量 `pnpm check`
通过类型检查和 lint 后在 CLI 测试停止。同步最新 main 后，三项 Pi 能力失败
已复测通过；本次未改动的 `workspace-git-service.test.ts` GitHub 远程仓库
回填用例仍失败。Code Collab、平台及公共边界检查单独执行通过。剩余全量测试
和桌面打包端到端验证未完成。

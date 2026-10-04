# Agent Role 的机器级记忆身份

Status: implemented
Translation: current

[English](2026-10-04-agent-role-memory.md)

## 摘要

Role 原先没有可复用的记忆身份。本次加入通过机器路由的记忆 Provider 边界及 Nowledge Mem
适配器，支持设置页发现和创建身份，并在 Role 中关联。Role 与 turn 只保存身份引用，实际
记忆仍由 Provider 管理。引用贯穿分发、预热匹配和 Operation 恢复，切换身份需要重启 ACP
进程。Agent 端 Mem 插件安装仍是独立前提。

## 决策与证据

[草案 Spec](../../../../specs/agent-role-memory.zh.md) 扩展既有的
[Role 发现契约](../../../../specs/agent-role-mentions.md)。旧目录规则中的“无记忆”现在明确为
不保存记忆内容与凭证，允许非敏感的身份引用。Role 的可见性和目录本地持久化规则不变。

已安装 nmem CLI 的帮助说明 enrollment 必须提供位置参数 ID，名称、描述、角色、默认 Space
为可选参数。状态返回顶层 `status`，身份列表返回含 `id` 与 `displayName` 的 `agentProfiles`。
Enrollment 只创建身份，所以 Lody 刷新权威列表，不将已有 ID 当成被更新的档案。
测试只使用合成身份。

```text
设置 / Role 编辑器 → 机器 RPC → Provider 探测、列表、创建
Role 引用 → 冻结 turn / Operation → 预热匹配
          → ACP 启动环境 → Nowledge Agent 身份
```

把 shell 命令或任意环境变量放进共享目录虽然方便扩展 Provider，但会暴露命令执行配置面。
因此命令与环境映射留在 daemon 适配器中，界面消费统一状态、身份记录及基础创建字段。
请求保持机器和 runtime 所有权，旧请求的迟到响应不能覆盖新机器的结果。

## 验证

适配器测试覆盖未安装、未运行、错误响应、字面量参数及创建后的列表结果。Role、Loro 输入、
预热、Operation、机器路由和 ACP 启动测试覆盖冻结引用。执行服务的 149 项测试也覆盖切换与
取消身份关联后的进程恢复；manager 测试确认退休进程不会发出旧生命周期事件。

类型、lint、i18n、平台/公共边界和文档检查通过，Electron 的 199 项测试通过。Storybook 浏览器
检查覆盖有数据、空列表、未安装、未运行、离线、加载状态及手风琴交互，无页面错误。

`pnpm check` 尚未全绿：现有 GitHub remote 识别问题造成 `workspace-git-service.test.ts` 的
一项及 `shared/tests/local-project.test.ts` 的三项案例失败。
使用 `git show HEAD:<path>` 提取 workspace-service 测试及运行时依赖源码到隔离临时目录后，同样失败；禁用全局和
系统 Git 配置也未解决。没有修改无关 Git 行为。检查不代表人类已批准草案 Spec。

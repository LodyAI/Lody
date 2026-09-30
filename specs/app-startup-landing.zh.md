# 应用默认入口

Status: draft
Translation: current

[English](app-startup-landing.md)

应用从默认入口打开时，可用工作区进入 chat landing（`/$workspaceName/chat`）。
上次访问的对话或工作界面不得决定启动目标。

工作区选择沿用现有规则：本地模式使用本地工作区，登录模式使用首选或当前可用工作区。
登录、引导、初始化和创建工作区的前置流程继续适用。

不再持久化上次访问的路由。旧的 `lody:lastAppRoute` 值会被忽略，
启动占位界面也不再读取它。显式深链接和明确指定目标的独立窗口继续打开请求的页面。
刷新具体 URL 或让已打开窗口回到前台，沿用当前导航语义。

## 依据

- 入口路由：[index.tsx](../packages/components/src/routes/index.tsx)。
- 回归覆盖：[home-route.test.tsx](../packages/components/tests/home-route.test.tsx)。
- 决策：[移除路由恢复](../.agents/notes/implemented/simplification/2026-09-29-startup-chat-landing.zh.md)。

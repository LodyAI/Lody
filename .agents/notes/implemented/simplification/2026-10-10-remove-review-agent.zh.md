# 移除 Review agent 实验功能

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1393

[English](2026-10-10-remove-review-agent.md)

## 摘要

Review agent 通过实验开关提供每个会话的审查和自动合并，但关闭 UI 开关后，
daemon 循环仍会继续运行。只删开关会留下不可见的自动化，或使它默认可用。
因此此次移除 UI、daemon 循环、reviewer MCP 工具以及共享的 review policy/run 实现。
保留历史数据，旧指针不再生效，手动 PR 操作继续使用共享 prompt。

预期行为记录于 [移除草稿](../../../../specs/review-agent-retirement.zh.md)。
Fleet 不再组装 review scheduler 或 credential resolver。会话菜单、Provider 设置、
实验偏好、翻译和 stories 均去掉审查入口。被删除的 engine 测试只覆盖已移除的行为，
同时删除原有的源码结构开关测试。MCP 目录和会话菜单测试覆盖入口消失；
Edit & Resend 测试通过真实历史替换验证旧元数据得以保留。

自动审查与手动 PR/commit prompt 原先共用 `review-prompts.ts`，后者移至
`pr-prompts.ts`，导出的值保持不变。旧 review Flock 行与会话指针不重写、不删除；
旧 daemon 不在更新后运行时的保证范围内。已执行中的 reviewer turn 仍是普通 agent 工作，
因此移除此功能并不构成取消协议。

## 验证

CLI 定向测试通过 61 项，UI 定向测试通过 28 项，包含手动 PR prompt 和保留的
Roost 开关。Shared 与 components 类型检查、lint、翻译 key 检查、
public/platform/process/Code Collab 边界检查、格式化和文档检查均通过。
文档检查仍报告既有维护警告，没有已注册的 SHA 主题。根目录完整类型检查和 lint 均通过，但整仓检查中的
`apps/cli/tests/roost-session-backend-contract.test.ts` 在 signed-prefix
复用/恢复与旧 writer fencing 用例上超时 30 秒，单项复跑同样超时。
此次移除没有改动该 Roost 测试及其历史后端，但未执行基线对照，
复现失败后停止了剩余整仓测试，因此不能声称完整检查通过。
不声称已完成发布环境或视觉验收。

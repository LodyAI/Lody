# 补全对话预览 runtime 的提示订阅读取接口

Status: implemented
Translation: current
PR: [#1997](https://github.com/LodyAI/Lody/pull/1997)

[English](2026-10-28-preview-runtime-prompt-subscription.md)

## 摘要

桌面 smoke 场景进入产品前就失败了：引导页复用的真实输入框订阅提示建议时发生崩溃。
main 增加了该订阅，但冻结的引导预览 runtime 和对话示例 runtime 没有补齐方法。
main 已通过 #2001 提供引导页修复；本 PR 保留对应的对话示例修复。
两个冻结 runtime 均通过带类型检查的接口返回无建议状态和清理函数。
生产订阅逻辑不变；新提交的完整桌面验收结果仍以 CI 为准。

## 证据与决定

运行 `40628058358` 的六个 smoke 场景都等不到 Agent 配置标题。
失败截图显示实际错误为 `subscribePromptSuggestion is not a function`，并非标题加载慢。
#1951 引入的共用输入框 hook 调用这一必需接口；`tourRuntime` 从部分对象强制转换类型，
掩盖了缺失字段。对话 Storybook runtime 存在相同遗漏，也阻断了保留新建页的发送衔接示例。

引导页修复及其隔离行为测试由[上游修复记录](2026-10-28-onboarding-tour-prompt-subscription.zh.md)负责。
本 PR rebase 后保留上游实现并移除重复改动，剩余 runtime 修改属于 `SessionConversationPage.stories.tsx`。
在各 fixture 所有者处补齐冻结读取接口，不在生产 hook 中吞掉缺失接口，也不放宽测试断言或超时。
fixture 同步发布 `null`，返回清理函数，不访问外层机器或云端 runtime。
方法使用 `WorkspaceRuntime['subscribePromptSuggestion']` 检查类型。

## 验证与限制

已有的引导隔离测试现在调用真实提示订阅 hook，并检查空建议与 fixture 项目数据的可见状态。
修复前它以 CI 相同的 TypeError 失败，修复后通过。已有浏览器流程覆盖跳过配置、准备中的配置完成，
以及移动端首次发送的保留页面衔接。完整桌面 smoke 需检查推送提交对应的 CI；本地浏览器检查
不代表 Electron 或真机验收。

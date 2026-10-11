# 输入框上方的执行机器归属

Status: outdated
Translation: current

[English](composer-machine-owner.md)

此提案的实现已于 2026-10-11 按用户要求撤回。以下保留原提案意图，
不代表当前行为；info bar 不再常驻显示机器名称与主人。

## 场景与意图

团队成员在发送消息前，需要知道当前会话由谁的机器执行。在输入框上方常驻显示
机器主人的头像、姓名和机器名称。其他信息栏项目切换或获得焦点时，该归属仍然可见，
窄屏也不例外。

归属来自当前会话所选机器元数据的 `ownerUserId`，不是会话创建者或可转移的会话所有者。
当前用户的机器显示“我”；无法解析成员时显示“未知成员”，不猜测归属。离线不清除
机器身份。机器元数据已删除或尚未加载时，不编造名称，也不复用上一会话的归属；
元数据就绪后的删除状态继续由现有状态栏说明。

窄屏优先保留主人信息，机器名称可省略截断，其他信息栏内容允许另起一行。
本改动只负责展示，不新增后端、缓存、权限或切换机器操作。

## 证据与评审

实现在 `packages/components/src/components/sessions/` 下的
`session-chat-interface.tsx` 和 `session-info-bar.tsx`。
桌面和窄屏合成数据预览复用现有 SessionConversationPage Storybook。
视觉确认及真实团队会话验证仍待完成。

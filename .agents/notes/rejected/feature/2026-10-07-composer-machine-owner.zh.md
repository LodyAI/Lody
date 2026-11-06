# 输入框上方常驻机器归属

Status: rejected
Translation: current

[English](2026-10-07-composer-machine-owner.md)

## 摘要

已于 2026-10-11 拒绝：用户要求回退该功能，实现已在
[#1431](https://github.com/LodyAI/Lody/pull/1431) 移除，常驻的主人头像与姓名让输入框
信息栏显得拥挤。此提案原本希望让团队协作者识别执行机器的主人，在共享信息栏中常驻显示
头像、主人和机器名称，窄屏时其他控件另起一行。保留此记录是为了防止重新引入常驻主人
展示；归属现在放在按需打开的[机器详情卡](../../implemented/feature/2026-10-11-composer-machine-info-card.zh.md)中。
视觉批准与真实团队会话验证从未完成。

## 决定与限制

归属使用 `sessionMachine.ownerUserId`，不使用 `session.userId`。
复用 `UserAvatar` 和页面已有的成员列表。未知归属明确展示，离线时保留身份，不新增缓存。
常驻标签避免将用户需要的信息藏进折叠图标，代价是在 600px 以下使用第二行。
现有会话 Storybook 仅注入合成身份数据，输入框与信息栏均为实际组件。

预期行为见[草案](../../../../specs/composer-machine-owner.zh.md)。2026-10-10 在 Chromium
中检查了现有桌面与移动端 Storybook 场景，合成数据的主人和机器名标签均可见。
未生成截图。这些检查证明组件能使用测试数据显示归属信息，不证明真实工作区成员
解析正确，也不代表视觉批准。真实团队会话验证仍待完成。

## 拒绝原因

用户于 2026-10-11 要求撤回此功能，因为常驻主人展示让输入框信息栏显得拥挤。已移除实现、归属专用预览、测试与翻译，
恢复原信息栏布局。此提案不再有效，见
[撤回决定](../../implemented/simplification/2026-10-11-revert-composer-machine-owner.zh.md)。

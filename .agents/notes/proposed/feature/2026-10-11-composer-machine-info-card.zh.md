# 执行机器名称与按需展开的详情卡

Status: proposed
Translation: current

[English](2026-10-11-composer-machine-info-card.md)

PR: [#1468](https://github.com/LodyAI/Lody/pull/1468)

## 摘要

常驻的主人头像与姓名让输入框显得拥挤，但只在菜单里展示机器信息，又让执行目标
更难辨认。此提案在桌面保留显示器图标和机器名称，归属放在悬停或点击展开的卡片中；
手机使用图标按钮，点击打开同一张卡片。它复用已有元数据、成员解析和在线状态，保留
固定顺序的折叠项与展开项行为。桌面名称占用空间，手机需要点击才能辨认目标；视觉
确认和真实团队会话验证仍待完成。

## 决策与边界

已有选项是仅在菜单中展示，以及
[已撤回的常驻主人信息提案](2026-10-07-composer-machine-owner.zh.md)。只有机器入口时
信息行透明，组合场景保留已有背景。长名称截断，卡内显示完整名称、主人、连接状态和
已知时的本机或其他设备。手机不增加身份信息行，保留会话菜单已有的机器入口。

归属取机器 `ownerUserId`，不能使用可转移的会话所有者。元数据缺失时移除入口，机器
ID 改变时关闭旧卡片。在线状态未解析时保持中性，本机身份未知时省略设备一行。
共享父组件复用已读取的数据，不新增网络请求、生命周期服务或平台能力；纯展示改动
无需 Effect 迁移。手机容器宽度不超过 420px 时，私有权限标签收起为锁图标，保留完整
无障碍说明和分享操作，为仓库操作留出空间。
已有 [Spec](../../../../specs/composer-machine-owner.zh.md) 返回 draft 等待视觉评审；
[撤回决策](../../implemented/simplification/2026-10-11-revert-composer-machine-owner.zh.md)
保留了此前实现被移除的原因。

## 证据与验证

`session-chat-interface.tsx` 为 `session-info-bar.tsx` 和 `session-machine-info.tsx`
提供所选机器。SessionConversationPage stories 使用真实输入框；SessionInfoBar stories
用合成数据覆盖仅机器、组合、窄窗口、私有权限与仓库操作、离线及在线状态未解析。
所属测试集 17 个测试通过，覆盖显隐、展开项切换、归属降级、目标变化、元数据移除、
未知本机身份及独立操作。组件类型、翻译 key、相关 lint 和 diff 检查通过。Chromium
桌面检查覆盖中英文、深浅色、悬停、Enter、Escape、焦点恢复、长名称和无溢出的 420px 组合场景。

Chromium/WebKit 在 375/390/430px 下，切换 Goal 前后控件均在 32px 行内，点击命中、
触摸、外部点击关闭和 Escape 验证通过。长名称、离线或未知状态、中文浅色卡片都在视口内。
保留 Goal/定时任务时，Create PR 及次要操作菜单仍可用。独立私有会话检查在两个引擎的
三种宽度下全部通过，桌面保留权限文字。WebKit 工作中场景报告 ResizeObserver 通知
未交付的提醒，布局与触摸验证仍通过；未观察到其他页面异常。

根目录 `pnpm check` 的类型检查通过，lint 被无关的未跟踪 `lody-roost-native/` 阻断；
排除该独立目录后 lint 通过。其余静态/边界检查、`pnpm format` 和 Storybook 生产构建通过。
首次全量测试遇到未改动 CLI 测试比较 macOS `/var` 与 `/private/var` 路径的断言；
`TMPDIR=/private/tmp pnpm test:ci` 全量通过，其中组件测试 5,095 个。
`pnpm run docs check` 保留 6 个指向未初始化 Kimi/Pi 子模块的既有错误，无新增错误或
受 SHA 保护的主题。合成数据不能证明真实成员解析、部署版本/实体设备行为或用户批准。

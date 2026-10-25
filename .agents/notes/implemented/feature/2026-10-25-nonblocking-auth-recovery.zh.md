# 非阻塞的认证恢复体验

Status: implemented
Translation: current

[English](2026-10-25-nonblocking-auth-recovery.md)

## 摘要

认证恢复耗尽后，原先会打开全局警告对话框，但耗尽不能证明登录失效。恢复现在显示为侧栏现有工作区控件旁的常驻图标，详情和恢复操作由用户主动打开，不新增状态行。页面保留焦点和仍可用的操作，受保护操作继续遵守现有认证门控与有界重试策略。这一版已有确定性的组件及 provider 测试和 Chromium 验收截图，但证据不涵盖真实凭证过期和视觉批准。

## 决策与职责

[`AuthRecoveryErrorView`](../../../../packages/components/src/components/auth-recovery-error.tsx)
组合现有 Button、非模态 Popover、国际化文案和 StyleX token，不自动展开、不抢焦点、不加遮罩。
关闭详情后保留状态入口，Escape 把焦点还给触发按钮，温和的 live region 播报状态变化。
只有用户主动打开面板后，它才可能遮住附近内容。

[`AuthRecoveryEntryProvider`](../../../../packages/components/src/components/auth-recovery-entry.tsx)
把 24px 图标投射到 `LoroSidebar` 现有工作区控件旁的 `AuthRecoveryEntrySlot`，
桌面端位于 footer，移动端位于 header。输入区和 footer 保持原有高度，健康状态没有图标。
入口随侧栏显示与隐藏。稳定的 ref context 只负责 slot 注册，外壳不订阅恢复状态。
常驻入口让恢复操作始终可发现；短暂 toast 会让操作消失。固定在视口角落的方案被放弃，
因为附近控件和侧栏内容会变化。这里采用上下文状态与按需详情，不声称复制 Linear 当前的实际实现。

没有挂载侧栏 slot 的界面（如工作区准入前），使用底部安全区上方的小型悬浮入口。
它保留恢复操作，但不在下述桌面无重叠验证范围内。

[`AuthenticatedConvexProvider`](../../../../packages/components/src/providers/authenticated-convex-provider.tsx)
继续独占调度和重试，沿用已有网络观测，提供恢复中、耗尽和浏览器离线的呈现，不新增调度器。
主动重试保留同一个界面并更新状态，成功恢复后移除。界面以会话身份为 key，避免待处理的重新登录和错误状态跨会话保留。
重新登录复用已有退出动作，进行中禁用重复操作，拒绝时通过可重试的内联错误承接。

本修改部分替换[有界恢复决策](../bug-fix/2026-10-10-bounded-auth-recovery.zh.md)中的对话框呈现。
六次尝试、每次超时、会话隔离、持续健康后重置预算、受保护请求门控与确认拒绝后的处理均保留。
离线切换不补充已耗尽次数。界面不重放变更、不清除本地数据、不承诺送达，也不把耗尽称为会话过期。
冷启动准入与纯本地模式保留现有行为。本次 React 呈现调整不新增 Effect 边界或依赖迁移。
[行为 Spec](../../../../specs/auth-recovery.zh.md)仍为草案。

## 证据与限制

所属组件和 provider 测试共 17 项通过，覆盖非模态挂载、草稿焦点、侧栏 slot 挂载与清理、主动打开详情、主动重试、重新登录进行中及失败、离线与恢复中呈现，以及已有重试、超时和会话隔离行为。
Playwright 1.58.2 使用已安装的 Chrome，在 1440×900 英文暗色工作区验证故障出现时保留输入焦点并继续输入、
Escape 恢复触发按钮焦点，以及输入区和侧栏 footer 几何位置不变。
图标位于 footer 内，不与同级操作或更新按钮重叠。
试点击确认帮助、归档、设置、更新、新建标签和发送操作仍可触达，无页面异常。
前后及详情展开截图使用真实 `LoroSidebar`、`SidebarUpdateBanner`、`WorkspaceCard`、会话标签、消息流、信息栏和输入框，
只提供合成数据，不使用实际凭证或捕获的对话。
本地预览对复用 ACP 依赖缺少的子代理导出使用未提交的兼容 shim，没有替换上述 UI 组件。

范围内类型感知 lint、全仓库格式和国际化检查通过。根目录 `pnpm check` 因依赖不可用，停在 `packages/ignore` 类型检查。
组件包类型检查被复用依赖缺失、版本和工作区导出不匹配阻塞，没有在修改文件中报告诊断。
文档检查仍有指向不可用 ACP 子模块的既有断链，以上检查均不能证明全仓库构建通过。
真实认证过期、实体设备键盘与安全区、全产品操作可用性仍需单独验证；本修改保留这些操作的既有门控。

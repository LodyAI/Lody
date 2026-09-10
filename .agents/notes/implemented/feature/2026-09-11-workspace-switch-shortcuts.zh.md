# 固定工作区 ID 的数字切换命令

Status: implemented
Translation: pending

## 摘要

工作区选择此前在三个 UI 入口分别组合 organization 激活、Jotai identity、preferred slug 和路由写入，无法可靠复用于数字快捷键或后续 swipe。现在普通切换统一由 workspace-ID hook 执行，1–9 slot 作为按用户、按设备的稳定 ID 映射保存，并由 `useCommand` 注册 Electron `Mod+1..9`。设置页复用既有快捷键冲突系统并单独编辑 slot 目标；公开 OSS E2E 受单一本地工作区限制，真实双工作区跳转由组件集成测试验证。

## 决策

首次初始化使用当前可导航 workspace 目录的前九项，是为了让功能无需设置即可使用。初始化后不再从列表位置推导编号：成员列表重排保留 ID，删除或失去权限仅留下空 slot，同一 ID 被重新分配时从旧 slot 移走。选择“每次按当前列表取第 N 项”虽然不需要存储，却会让排序变化在用户不知情时改变快捷键目标，因此拒绝。

Slot 存储按 user ID 分 key，避免同一设备切换账号时相互清空；它与键位覆盖一样是设备偏好，不进入 Loro 或云端 workspace 数据。模块内一个引用计数 storage listener 同步所有 renderer，本窗口写入直接发布快照。没有增加 Electron IPC，因为同一 session 的 localStorage 事件已经覆盖窗口一致性。

`useWorkspaceSwitcher` 统一普通用户导航的顺序：验证 ID 与 slug、当前 workspace 无操作、写 preferred slug、原子发布 slug/ID、请求 organization 激活、导航当前窗口到 workspace home。侧栏、mobile home 和 organization selector 改用该入口；onboarding 恢复、创建和删除补偿仍保留自己的事务，因为它们不仅是普通导航。

九个命令的默认键位限制在 Electron，避免 Web 浏览器吞掉 `Mod+1..9`。只有目录中仍可访问且已分配的 slot 挂载命令；`useCommand` 让命令继续使用 #572 建立的统一 capture host、设置录制、用户覆盖和 canonical 冲突索引。slot 目标选择与键位编辑分开：前者保存 workspace ID，后者仍完整替换命令默认绑定。

## 验证与限制

纯逻辑和 React 集成测试覆盖首次分配、目录重排、删除留空、唯一分配、账号隔离、另一 renderer storage 更新、非法目标、当前 workspace 无操作，以及切换后的 preferred slug、Jotai context、active organization 和路由结果。现有桌面 P0 shortcut journey 在主窗口与辅助窗口中增加 slot 命令及 `Mod+1` 展示检查。公开 local-only Electron 只有一个隐式 workspace，不能在不引入被禁止的云端请求或测试后门时执行 A→B，因此真实跨 workspace 跳转保留为组件级边界证据。

本决策延续[统一快捷键窗口生命周期](../bug-fix/2026-09-10-shortcut-window-lifecycle.zh.md)，产品契约见[工作区切换快捷键](../../../../specs/workspace-switching-shortcuts.zh.md)。需求：[Issue #288](https://github.com/LodyAI/Lody/issues/288)。

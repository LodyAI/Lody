# 应用图标选择

Status: draft
Translation: current

[English](app-icon-selection.md)

支持备选图标的原生宿主允许用户在外观设置的字号下方，根据预览选择应用
内置图标，并能恢复默认图标。不具备此能力的宿主不显示图标选择器。

宿主提供图标列表，读取和修改系统正在使用的图标。共享界面等待原生确认
后才移动选中标记，切换过程中禁用选择，失败时保留原来的选中项并显示
可重试的错误。重新打开设置时再次读取原生状态。选择属于当前设备，
不属于工作区或账号偏好。

## 实现证据

- `packages/components/src/components/mobile/mobile-app-icon-settings.tsx`
- `packages/components/tests/mobile-app-icon-settings.test.tsx`
- `packages/components/src/stories/MobileAppIconSettings.stories.tsx`

本仓库不负责原生打包，也不能据此确认真机行为。

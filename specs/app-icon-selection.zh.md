# 应用图标选择

Status: draft
Translation: current

[English](app-icon-selection.md)

支持备选图标的原生宿主允许用户在外观设置中，根据预览选择应用内置图标，
并能恢复默认图标。桌面端位于 Terminal 设置下方，iOS 位于字号下方。
不具备此能力的宿主不显示图标选择器。

宿主提供图标列表，读取和修改系统正在使用的图标。共享界面等待原生确认
后才移动选中标记，切换过程中禁用选择，失败时保留原来的选中项并显示
可重试的错误。重新打开设置时再次读取原生状态。选择属于当前设备，
不属于工作区或账号偏好。

已打包的 macOS 桌面应用提供“默认”和 Aqua。主进程串行处理多个窗口的
切换请求，将确认成功的选择保存在本机，并在启动时重新应用，避免更新替换
应用包后丢失偏好。“默认”会清除 Finder 自定义图标，运行中的 Dock 同步
所选图标。Windows、Linux、浏览器及未打包的 Electron 不提供此能力。
只接受内置图标标识，不接受渲染进程传入的文件路径。

macOS 自定义图标使用 Finder 元数据。签名覆盖的资源保持不变，普通签名
校验通过，但严格校验会拒绝这些元数据，直到恢复默认图标。发布产物仍须
不带自定义元数据，并通过严格签名和公证校验。

## 实现证据

- `packages/components/src/components/mobile/mobile-app-icon-settings.tsx`
- `packages/components/tests/mobile-app-icon-settings.test.tsx`
- `packages/components/src/stories/MobileAppIconSettings.stories.tsx`
- `apps/electron/src/main/services/app-icon-service.ts`

开发期间的原生探针曾在临时签名的 macOS 应用包上验证图标落盘与签名资源保留。
本功能的原生与控制器测试文件随后已移除，上述结果仅为历史验证证据。
完整的已公证应用更新流程仍需发布验证。iOS 打包由外部宿主负责。

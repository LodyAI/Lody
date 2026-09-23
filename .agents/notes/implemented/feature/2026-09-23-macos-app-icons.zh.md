# macOS 持久应用图标选择

Status: implemented
Translation: current

[English](2026-09-23-macos-app-icons.md)

## 摘要

已打包的 macOS 桌面应用在外观设置的字号下方提供“默认”和 Aqua 预览。
复用原生宿主选择器，将成功选择保存在本机，重启或应用包替换后恢复。
AppKit 修改 Finder 自定义元数据，Electron 同步运行中的 Dock。
普通签名校验通过，但严格校验拒绝自定义图标元数据；恢复默认会清除它。
尚未验证已公证应用的完整更新流程。

## 决策

本实现扩展[宿主图标选择决策](2026-09-20-app-icon-selection.zh.md)。
渲染进程仅在 macOS 安装已有可选桥接，主进程将未打包环境标记为不支持，
避免修改共享 Electron.app。图标来自内置资源，IPC 校验产品窗口来源并
拒绝任意路径。异步队列串行处理启动、读取和多窗口切换。原生应用成功后
才持久保存，保存失败则回退原生图标。偏好存储仅在队列操作内打开；损坏的
图标设置恢复为默认，文件系统错误仅作为可重试的图标错误，不中断应用启动。

```text
外观选择器 → app IPC → 图标串行控制器
                       ├─ AppKit 自定义图标 + Electron Dock
                       └─ userData/app-icon.json
启动／设置读取 → 将已保存选择重新应用到当前应用包
```

通过系统 `/usr/bin/osascript` 的 Objective-C 桥接调用 NSWorkspace，
无需下载辅助程序或运行时编译器。路径通过 argv 传递，不拼接进脚本。
ASAR 图像复制到临时真实文件，AppKit 使用后删除。Aqua 与 iOS 备选图标
使用同一份美术资源。

## 证据与限制

测试覆盖重启／更新恢复、默认重置、原生及保存失败、并发串行和不支持／
非法输入。macOS 探针检查 Finder 标记、签名资源未变、普通签名校验，
以及清除图标后的严格校验。已安装 Lody 的副本也得到相同结果，未修改
原安装应用。

修正最初的假设：不修改签名资源**不代表**所有签名检查都通过。
`NSWorkspace.setIcon` 添加 FinderInfo 和资源分支；普通校验通过，
`--strict` 会拒绝这些元数据。参见
[Apple QA1940](https://developer.apple.com/library/archive/qa/qa1940/_index.html)。
发布产物签名／公证前不得应用此自定义。现有安装本身被系统判为
Unnotarized Developer ID，因此无法据此确认 Gatekeeper 行为或已公证
应用更新流程，不能把这些未执行的检查描述为通过。

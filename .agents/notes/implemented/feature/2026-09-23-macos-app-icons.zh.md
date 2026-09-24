# macOS 持久应用图标选择

Status: implemented
Translation: current

[English](2026-09-23-macos-app-icons.md)

## 摘要

已打包的 macOS 桌面应用在外观设置的 Terminal 下方提供“默认”和 Aqua 预览。
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
ASAR 备选图像复制到临时真实文件，AppKit 使用后删除。Aqua 源文件
`build/icon-aqua.png` 保留 iOS 原画。macOS 运行时资源每边增加 10% 透明留白，
并使用默认图标的透明通道轮廓匹配圆角。设置预览、Finder 和 Dock 均使用
派生 PNG；直接使用 iOS 满幅方图会导致 Dock 图标显得过大。
在 `apps/electron` 中重新生成（需要 Pillow 和 macOS iconutil）：

```sh
python3 scripts/pad-mac-icon.py --input-png build/icon-aqua.png \
  --output-png resources/app-icons/aqua.png --output-icns /tmp/lody-aqua.icns \
  --pad 0.10 --mask-png build/icon-mac.padded.png
```

设置或清除 Finder 图标后，原生辅助逻辑先强制执行
`LSRegisterURL(..., true)`，再通知 `NSWorkspace` 应用包已变更，最后更新
运行中的 Dock 图标。这会请求立即刷新已注册的应用信息，无需等到下次启动。
原生操作部分完成后若失败，会尝试恢复之前的图标，不保存失败的选择。
不删除全局缓存，也不重启 Dock。

## 证据与限制

按维护者要求，已移除本功能新增的原生／控制器测试及桌面 UI 测试参数化。
下述测试和消融结果记录开发期间的实验，不代表仍保留的回归测试覆盖。

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

已收到切换后第一次退出短暂恢复旧 Dock 图标、之后启动和退出均正常的反馈。
强制注册刷新属于缓解措施：Apple 文档保证更新 Launch Services 信息，
不保证 Dock 的启动时图标缓存会失效。加入刷新后的原生探针已通过，
确定性控制器测试覆盖图标已写入后刷新失败的回退。
尚未目视验证固定 Dock 图标的首次退出行为，反馈机器暂时无法远程访问。
必须在该机器验证“默认 → Aqua → 退出”和“Aqua → 默认 → 退出”，
才能确认缓存问题已解决。

## 消融证据

以 `0acb7427` 为基线，逐项移除，区分冗余和必要防护：

| 移除项 | 实验结果 | 决策 |
| --- | --- | --- |
| 默认图标的临时 PNG 复制 | 原生重置和严格签名结果一致；临时建目录、读、写、删除各从 1 次降为 0 次；临时存储不可用时也能恢复默认 | 删除 |
| 串行队列 | 多窗口竞争顺序测试失败 | 保留 |
| 回退逻辑 | 偏好写入失败、原生部分失败测试均失败 | 保留 |
| 启动时重新应用 | 重启／更新恢复测试失败 | 保留 |
| Conf 构造器归一化 | 打包使用的 CommonJS 导入是对象，直接构造报 `Conf is not a constructor` | 保留 |

服务实验转译真实服务，注入 Electron app 和带计数的文件系统，在临时签名
应用包上使用真实偏好存储和原生辅助函数。Aqua 仍会写入自定义图标并清理
临时 PNG。Dock 绘制接口使用注入实现，因此不能补足前述首次退出视觉验证。
没有把刷新调用认定为冗余：现有测试无法观察反馈中的 Dock 缓存问题，
移除后测试通过并不能证明行为等价。

# 修复 WebSocket sleep 崩溃的 Baguette 运行时

Status: implemented
Translation: current

[English](2026-09-29-baguette-runtime-sleep.md)

## 摘要

Baguette v0.2.0 在 WebSocket 自动 ping 任务结束第一次 30 秒等待时崩溃。带符号的 Release 构建确认失败调用位于 `WebSocketHandler.runAutoPingLoop`，关闭握手任务的同类等待也会崩溃。将锁定版本的 swift-websocket 中三处 `Task.sleep(for:)` 替换为 `ContinuousClock.sleep(until:)`，保留取消与计时语义。已验证的原生构建以 `0.2.0-lody.1` 分发，附带补丁和构建来源，不改变上游版本的已发布字节。v0.2.1 复查仍复现故障，因此同一补丁现以该源码版本为基础，作为 `0.2.1-lody.1` 分发。

## 证据与决定

官方二进制在 30.15 秒后异常退出；使用 Apple Swift 6.3.3 编译的未修改源码在 31.20 秒后异常退出。两者均在 `swift_task_dealloc` 报告 `freed pointer was not the last allocation`。符号定位到 swift-websocket 1.5.0 的 `WebSocketHandler.swift:227`。仅替换 ping 循环中的等待后可通过三次 ping，但关闭时第 191 行出现同类崩溃。全部三处替换后运行 92.7 秒，收到 106 个 JPEG 帧和三次 ping，主动结束测试后以退出码 0 正常退出。

这确认了失败调用与规避方案，并未独立证明编译器或 ABI 的具体机制。[Swift issue 86204](https://github.com/swiftlang/swift/issues/86204) 记录了相符的特化缺陷。仅使用本机较新编译器重编译不足以解决。关闭自动 ping 会失去连接保活，也无法解决关闭握手路径。

## 上游 v0.2.1 复查（2026-09-30）

[上游 v0.2.1](https://github.com/tddworks/baguette/releases/tag/v0.2.1)（提交 `db17446e25059247879dba7941e4de641c2f31e2`）修复的是独立 `baguette stream` 命令的启动崩溃（[PR #88](https://github.com/tddworks/baguette/pull/88)），Lody 使用的是 `baguette serve`。依赖锁文件和上游许可证均未变化，swift-websocket 仍固定为 `ca48d46c25f8fa948d37eaa480c73172182cf90f`。官方 arm64 归档（SHA-256 `27196ca07dd3aa1f0f96d12100953e75ebd2059a145dfced7c88b229580e4b25`）仍以相同的分配器错误崩溃：运行 31.4 秒，收到一个 JPEG 帧，尚未收到 ping，以 SIGABRT 退出。

源码基线升级至 v0.2.1，保留原有三处调用补丁，以 `0.2.1-lody.1` 分发；发布说明不能证明 WebSocket 问题已经修复。以后移除规避方案前，须复查自动 ping 与关闭握手两条路径。这是对原决定的延续，不推翻上面的 v0.2.0 验证记录。

在 Apple Silicon/macOS 26.6.2、Xcode 26.6 和已启动的 iPhone 17 Pro/iOS 26.2 上，补丁源码构建运行 91.2 秒，收到三个 JPEG 帧和三次 ping，强制断开查看连接并发送 SIGTERM 后以退出码 0 结束。两次规范化归档打包结果一致。新的不可变镜像对象通过 R2 回读及独立公开下载地址的归档、可执行文件完整性检查。运行公开下载的版本持续 91.3 秒，收到三个 JPEG 帧和三次 ping，完成正常 WebSocket 关闭（1000），随后发送 SIGTERM，以退出码 0 结束。画面大部分时间静止，测试期间仅观察到三个帧；这些记录验证心跳与清理，不证明吞吐量或长期稳定性。关闭超时的失败分支及完整侧栏、远程、移动端 E2E 仍未验证。集成 PR：[LodyAI/Lody#1061](https://github.com/LodyAI/Lody/pull/1061)。

## 产物职责

[运行时清单](../../../../apps/cli/src/ios-simulator/baguette-manifest.json) 固定归档与可执行文件摘要，并记录上游和依赖版本、补丁摘要、编译器及命令。[打包器](../../../../scripts/package-baguette-runtime.mjs) 保留已验证可执行文件原始字节，生成包含资源、许可证、补丁及构建来源的确定性归档。[运行时 README](../../../../apps/cli/src/ios-simulator/README.md) 维护重建与打包说明。

独立的 Lody 修订版本对应新的下载对象和安装缓存，原上游版本缓存及不可变对象继续有效。更新清单随产品交付前，必须完成本地归档校验和上传后的远端回读校验。后续 mirror 运行复用同一已发布产物；构建字节变化必须再增加运行时修订版本。

## 验证范围

原生验证在 Apple Silicon/macOS 26.6.2 上覆盖 MJPEG、三次真实 ping 及进程关闭，不能替代长期运行或完整 Electron、远程、移动端验收。打包测试覆盖安装布局、确定性元数据，以及对变化的可执行文件、补丁、资源和符号链接的拒绝。以后更换依赖或工具链仍须执行既有 Xcode/iOS 兼容性检查。

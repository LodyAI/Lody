# iOS 发布工具链

状态：已实现

[English](2026-10-28-ios-publisher-sdk.md)

iOS 发布任务使用 GitHub Actions 的 `xcode-27` runner，并通过
`DEVELOPER_DIR=/Applications/Xcode_27.1.app/Contents/Developer` 选择 Xcode 27.1。
Nightly iOS 从 `nightly-electron.yml` 调用 `publish-ios.yml`，Stable iOS 使用
`release-cli.yml`。移动端部署目标为 iOS/iPadOS 16.4。

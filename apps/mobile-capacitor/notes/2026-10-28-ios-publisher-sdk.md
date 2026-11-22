# iOS publishing toolchain

Status: implemented

[中文](2026-10-28-ios-publisher-sdk.zh.md)

The iOS publishing jobs use the GitHub Actions `xcode-27` runner and select
Xcode 27.1 with `DEVELOPER_DIR=/Applications/Xcode_27.1.app/Contents/Developer`.
Nightly iOS calls `publish-ios.yml` from `nightly-electron.yml`; Stable iOS uses
`release-cli.yml`. The mobile deployment target is iOS/iPadOS 16.4.

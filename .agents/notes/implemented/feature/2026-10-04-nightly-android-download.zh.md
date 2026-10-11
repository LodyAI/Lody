# Nightly 页面提供 Android 下载

Status: implemented
Translation: current

[English](2026-10-04-nightly-android-download.md)

## 摘要

Nightly 页面此前仅提供桌面安装包。现在，当实时发布清单的两个下载列表都包含准确的版本化 APK 文件时，页面会显示 Android 下载。已有仅含桌面安装包的清单仍然有效，允许网站与发布流程独立上线。移动端签名发布由公开网站之外的系统负责，解析器测试不证明其已完成。

## 决策与证据

`site-docs/lib/nightly-downloads.ts` 保留配置的 HTTPS Nightly 根路径，不信任远端绝对地址。Android 是可选扩展，避免让已有发布失效；仅在一个列表声明 APK 时校验失败。页面仅在链接通过校验后显示 Android 卡片，并明确桌面切换提示的适用范围。

本改动扩展[桌面通道身份](../../proposed/architecture/2026-09-23-desktop-channel-identity.zh.md)描述的下载入口，不改变桌面身份。[草案契约](../../../../specs/desktop-channel-execution.zh.md)记录新增行为。解析器测试覆盖有效 APK、桌面清单过渡、缺失项及外部或路径穿越地址。网站生产构建和浏览器检查已通过，覆盖中英文页面以及仅桌面、桌面加 APK 两种清单。原生安装与产物可用性仍需发布系统验证。

PR: [LodyAI/Lody#1248](https://github.com/LodyAI/Lody/pull/1248)

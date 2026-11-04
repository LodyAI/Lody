# Linux ARM64 下载入口

Status: implemented
Translation: current

[English](2026-10-19-linux-arm64-downloads.md)

## 摘要

Linux 下载入口此前只提供 x86-64 安装包。下载页现在明确标注架构，并在发布清单声明后显示 ARM64 AppImage 和 Debian 安装包。Nightly 保持旧清单可用，但拒绝不完整的 ARM64 安装包组合。网站和发布流程因此可以独立上线；解析测试不代表原生安装验证通过。

## 决策与证据

官方桌面发布流程负责构建产物。Stable 链接使用发布清单映射，同时兼容历史 x86-64 别名与当前 x64 别名。ARM64 发布前不猜测 latest 地址。Nightly 要求两个清单列表包含精确版本文件名，链接始终位于配置的 HTTPS 根路径。

如果网站强制所有清单包含 ARM64，首个对应版本发布前会隐藏全部下载。增量规则保留旧版下载，一旦声明任一 ARM64 安装包则要求 AppImage/deb 完整配对。这延续了 [Android Nightly 下载](2026-10-04-nightly-android-download.zh.md) 的上线策略。既有 Nightly 组件直接渲染新增 Linux 项，无需另建布局。

测试覆盖完整组合、旧清单、缺失条目和路径穿越映射。真实 Linux ARM64 安装仍需发布流程和原生 runner 验证。

PR: [LodyAI/Lody#1705](https://github.com/LodyAI/Lody/pull/1705)

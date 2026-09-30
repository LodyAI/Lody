# 自动刷新 Grok 运行时校验值

Status: implemented
Translation: current

[English](2026-09-25-grok-pin-refresh.md) | 中文

## 摘要

Grok 镜像脚本可能下载新版本，却仍使用旧的硬编码来源哈希校验；CLI 与镜像脚本还重复保存归档校验值。现在两者读取同一个带版本的 manifest，版本变化时根据官方 npm 元数据生成六个平台的校验值，只有生产上传和回读全部成功后才原子更新 manifest。已有 1.0.40 CLI pins 原样迁移，并通过真实上游包验证；本次没有执行生产上传。

## 决策

adapter 选择版本，`grok-runtime-manifest.json` 保存来源完整性、归档与可执行文件的 SHA-256 和大小。CLI 拒绝版本不同步。镜像脚本验证精确包名、版本、官方 URL 和 SHA-512，然后将解压后的原生程序重复打包两次验证可复现性。六个平台全部成功且通过标准生产通道回读后，才能写入新 pins。dry-run、仅打印、跳过上传及自定义通道均不更新 manifest。同一不可变对象冲突或同版本来源哈希不符仍会报错。

此项扩展了[先产物后 manifest 的刷新流程](2026-09-17-managed-runtime-refresh.zh.md)，没有改变版本选择方式。Codex、Claude 已有 manifest 自动刷新；Kimi、Pi 从可复现源码构建生成 manifest。没有采用哈希不匹配后直接信任下载内容的方案，因为那会失去来源完整性校验边界。

## 验证

六个官方 Grok 1.0.40 包通过了来源校验、可复现打包，以及现有归档和可执行文件 pins 校验，使用 `--skip-upload`。运行时 manifest 测试和 CLI runtime 测试共 57 项通过，CLI 类型检查和文档检查通过。使用旧 manifest 的测试重新生成了六个平台的 pins，拒绝部分平台刷新，并确认 `--skip-upload` 保持生产 manifest 不变。本次没有执行生产上传回读或已登录运行时验证。

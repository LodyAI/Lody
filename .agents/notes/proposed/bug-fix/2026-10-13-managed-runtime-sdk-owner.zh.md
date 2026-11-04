# 使用 adapter 的 SDK 校验托管 runtime 清单

Status: proposed
Translation: current

[English](2026-10-13-managed-runtime-sdk-owner.md)

## 摘要

adapter 依赖更新后，main 的锁文件没有同步，冻结安装因此失败。安装恢复后，旧 runtime 清单触发了版本检查；刷新 Claude 清单又暴露出第二个问题：CLI 使用自己的开发 SDK 校验清单，而不是实际启动 runtime 的 adapter SDK。本次修复同步依赖图、刷新已校验的 runtime 清单，并从 Claude adapter 读取 SDK 元数据。严格的版本与文件完整性检查继续保留。本地检查不能证明 Windows 桌面下载成功，也不能代替合并后的 main CI。

## 决策与证据

Claude adapter 拥有内置启动使用的 SDK，因此预期 SDK 与 Claude Code 版本由它的 package 和 manifest JSON 决定。CLI 开发依赖可能解析到不同版本，不能用来决定 adapter runtime 清单。删除版本检查会隐藏不兼容的归档，所以保留检查，只修改元数据来源。

Codex、Claude、Grok 和 Pi 清单在文件哈希和大小校验后刷新。锁文件与已提交的 adapter 依赖声明对齐，依赖发布等待期规则没有改变。两个托管 runtime 测试文件使用新清单及 adapter 元数据导入，39 个测试全部通过。完整仓库检查完成后记录在 PR 中。

本次修复与[登录下载取消提案](2026-09-21-acp-auth-runtime-download.zh.md)不同：修改的是清单的版本来源，不是登录进度或取消行为。原生平台执行、Windows 桌面引导与合并后的 main CI 仍需分别验证。

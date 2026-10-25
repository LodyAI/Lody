# 接入正式发布的存储恢复修复

Status: proposed
Type: bug-fix
Translation: current
PR: [#1831](https://github.com/LodyAI/Lody/pull/1831)

[English](2026-10-23-storage-recovery-release-adoption.md)

## 摘要

存储失败可能反复下载已经应用的房间更新，让会话继续绑定被替换的副本，或让 IndexedDB 无法重新打开。Lody 接入经过审核的正式版本 `@loro-dev/streams-crdt` 0.19.2 和 `loro-repo` 0.25.0，并移除临时的存储观察接口补丁。桌面满盘保护保持原有行为，改用正式发布的观察接口。这些修复限制故障放大并恢复自愈能力，但不会让已满的磁盘变得可写。

## 发布与职责

- [streams #435](https://github.com/loro-dev/loro-streams/pull/435) 通过 [#436](https://github.com/loro-dev/loro-streams/pull/436) 发布，在内存中保留已应用进度，独立重试持久化。普通存储失败期间继续读取和上传。首次同步确认仍等待远端尾部，持久化游标始终不越过已存盘状态。
- [Repo #162](https://github.com/loro-dev/loro-repo/pull/162) 退役绑定旧副本的会话。与待补依赖更新持久化的冲突通过保留 `unloadDoc` 返回被卸载实例的契约解决，同时保留主分支持久化实现。[#163](https://github.com/loro-dev/loro-repo/pull/163) 重开被浏览器关闭的 IndexedDB 连接；[#164](https://github.com/loro-dev/loro-repo/pull/164) 提供原生存储写失败回调。
- Lody 固定这两个正式版本，并增加经审核的发布时间豁免。删除 0.24.0 回补补丁，保留现有原生 SQLite/IndexedDB 集成覆盖。其他依赖和满盘策略保持原有职责。

原有[流量问题调查](2026-10-22-streams-persistence-failure-bandwidth.zh.md)与[桌面保护决策](../feature/2026-10-22-desktop-disk-full-guard.zh.md)解释不同的故障路径。本次接入取代其中尚未发布依赖和临时补丁的限制。CLI EPIPE 修复和满盘保护已经通过 Lody #1820、#1829 合入。

## 验证与限制

组合后的 Repo 改动通过类型和边界检查、723 项测试及发布包消费验证；冲突解决提交的 Linux、macOS、Windows CI 也通过。正式 npm 包通过冻结安装、完整 `pnpm check`、格式与文档检查。CLI 通过 4,524 项测试，组件通过 601 个文件、5,976 项测试；Electron 和其余工作区套件也通过。测试进程使用系统 Git，避免 agent 包装器影响 fixture。不宣称已经在真实满盘文件系统或报告者机器上复现。释放空间前持久化仍可能不可用，恢复能力也不代表尚未落盘的状态能够跨进程崩溃保留。

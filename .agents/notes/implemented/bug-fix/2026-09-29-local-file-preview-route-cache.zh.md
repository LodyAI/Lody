# 本地文件预览路由与能力缓存

Status: implemented
Translation: current

[English](2026-09-29-local-file-preview-route-cache.md)

## 摘要

Electron File Preview v3 原本已经使用本地 `file/resolve-local` IPC 路径，但每次请求仍会重复等待目标 plane 解析，并从 repo 元数据重新读取机器协议能力。现在已知路由时会直接使用，runtime 按机器缓存小型能力映射，并在机器文档元数据变化时失效。文件路径、文件内容、资源 URL、CLI 授权以及禁止云端回退的边界均未改变；改动范围只涉及 renderer 侧路由和元数据读取。

## 决策与证据

本地身份已经确定后，`WorkspaceTargetRouter.getPlaneForMachine` 是权威的快速路径。`requestFilePreview` 只有在路由未知时才调用原有解析器，因此 Electron 目标未解析时仍返回原有可重试错误，远端机器仍使用 Streams RPC。

协议能力保存在机器文档元数据中，用于协商 `localFileResources`。runtime 为每台机器保留一个已声明的能力映射，合并并发读取，在任何机器文档元数据事件到达时失效，并在销毁时清理。缺失的能力不会被缓存，因此旧 daemon 或尚未同步的机器仍按不支持处理，也不会延迟后续元数据更新。缓存不包含文件内容、路径或 renderer 持有的资源能力。

## 验证

facade 测试验证已知本地路由不会再次调用路由解析。runtime 生命周期测试验证连续两次本地预览只读取一次机器能力，同时仍发出两次 IPC 预览请求。两组测试共 54 项全部通过；Oxfmt 和 `git diff --check` 通过。组件包类型检查目前被此 checkout 缺少的 Electron 与 ACP 子模块依赖阻断；文档状态检查报告未初始化 ACP 子模块造成的既有缺失链接。

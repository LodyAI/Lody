# 保留 ACP 文件不存在的错误语义

Status: implemented
Translation: current

[English](2026-09-20-kimi-plan-file-errors.md)

## 摘要

Kimi 已进入 Plan 后，可能因计划文件尚未创建而报告配置失败。ACP 文件访问丢失了
原生的缺文件错误语义，后续读取 Plan 状态和关闭 Plan 也会失败。Lody 现在把
`ENOENT` 转成 ACP resource-not-found，Kimi 文件适配层再把该错误码转回
`ENOENT`。其他错误继续抛出；这次修复不改变规划或权限策略。

## 原因与边界

[Plan 消费者接入](2026-09-10-core-plan-mode-consumers.md)已经发送正确的布尔配置。
Kimi 先进入 Plan，随后为生成配置快照读取计划状态，此时计划文件可能尚未创建。
引擎允许原生 `ENOENT`，但 Lody 的文件错误跨协议后变成 JSON-RPC `Internal error`。
即使客户端正确返回 `-32002`，Kimi 仍未将其转成引擎能识别的缺文件错误。
配置响应失败不会撤销已经进入的 Plan 状态。

`AgentClient.readTextFile` 在验证会话后负责原生错误到 ACP 的转换；Kimi 的
`AcpHostFileSystem.readText` 负责 ACP 到原生错误的转换，并保留原错误为 cause。
append 继续保留缺文件时创建内容的行为，不向 Kimi 引擎加入协议专用逻辑。
只转换结构化 resource-not-found；任意内部错误或文本中包含 `ENOENT` 的错误
不视为文件不存在。提前创建计划文件或把所有读取失败都变成空内容会掩盖错误契约问题。

## 验证与交付

隔离的合成客户端在托管运行包 `2.0.0-lody.251770890d42` 上复现了问题，未调用模型。
本地文件访问正常；ACP 返回内部错误或 resource-not-found 时均失败。两端的回归测试
在各自修复前失败。CLI 测试覆盖缺文件、按行读取、非缺文件 I/O 错误和会话不匹配。
Kimi 测试覆盖使用和不使用 ACP 文件访问时重复开启、关闭 Plan 且保留 YOLO，
以及 append 和非缺文件读取失败。

Kimi 是单独构建的托管运行包。只更新源码和 gitlink 不会升级已安装的运行时；
推进运行包 manifest 前，需要构建并发布包含修复的校验和制品。本次源码修复
不发布生产制品。全仓验证的限制在 PR 中记录。

Lody PR：[#846](https://github.com/LodyAI/Lody/pull/846)。
Kimi PR：[#12](https://github.com/LodyAI/acp-extension-kimi/pull/12)。

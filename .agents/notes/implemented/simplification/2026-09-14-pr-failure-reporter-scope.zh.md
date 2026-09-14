# 将附件报告器限定为 PR 失败流程

Status: implemented
Translation: current

[English](2026-09-14-pr-failure-reporter-scope.md) | 中文

## 摘要

Daily 失败报告已不再下载证据或向 Issue 上传录像，但共享附件报告器及其大部分测试仍默认
覆盖不可达的 Daily 路径。报告器、命令、fixture 和断言现在都描述其唯一剩余的 PR
workflow 调用方。本次变更删除无效的 channel 分支，同时保持 PR 附件校验和 manifest
行为不变。

## 背景

[Daily 报告仅保留 artifact 的决策](../testing/2026-09-14-daily-failure-artifact-only-reporting.zh.md)
移除了 Daily workflow 对附件报告生成器的调用。PR reconciler 随后成为唯一调用方，并且
始终选择 `pr` channel；但生成器仍默认使用 `daily`，大部分测试也仍在覆盖这个默认值。

## 决策

生成器与测试文件名、导出函数、临时路径和 workflow 调用统一使用 PR 术语。生成器只产生
PR marker 和标题，直接校验 PR suite，并在 manifest 中保留 `channel: "pr"` 以兼容现有
调用方。附件所有权检查改用 PR marker；Daily 摘要所有权继续由独立的 Daily policy 测试
覆盖。

## 取舍

移除 channel 分支后，该 helper 不再适合未来共享的 Daily 附件流程。如果重新引入这类
流程，需要单独设计，因为当前 Daily contract 明确要求证据保留在 Actions artifact 中。

## 验证

应用户要求，本次后续变更未运行测试。重命名后的命令和测试由托管 CI 验证。

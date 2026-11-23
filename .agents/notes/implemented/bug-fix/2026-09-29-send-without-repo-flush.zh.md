# 发送不再等待 Repo 落盘

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1132

[English](2026-09-29-send-without-repo-flush.md)

## 摘要

发送接受流程原先在 dispatch 前等待 `repo.flush()`，因此每条消息都会依赖其他脏文档的落盘。用户要求移除这个等待。现在创建元数据、历史或队列、执行指针完成本地提交后即可接受发送，现有 Repo 落盘和传输上传独立进行。后台落盘完成前，本地接受不再保证崩溃后可恢复。本次改动尚未测量安装包中的启动耗时。

## 决策与证据

本次调整[移除发送日志](../simplification/2026-09-29-remove-session-send-journal.zh.md)决策中的 flush 步骤。`packages/components/src/lib/session-send-delivery.ts` 的 `writeUserTurn` 不再调用 `repo.flush()`。新对话、续发、队列、guide 和暂存发送共享这个写入边界。写入顺序和 RPC 回执语义保持不变。[附件 Spec](../../../../specs/session-files.zh.md)记录接受与持久化边界。

当前固定版本 `loro-repo` 0.21.1 的 `flush()` 会排空文档、Flock 和元数据的持久化任务；文档排空涉及所有脏文档，期间新增任务会继续处理。在此等待可能拖延无关会话的 dispatch RPC。没有改为后台触发一次全 Repo flush，持久化仍由 Repo 自身负责。

## 验证

`git diff --check` 通过。文档检查报告的 62 项错误与基线相同，没有新增错误。当前 checkout 未安装依赖，测试命令因缺少 Vitest 无法启动；运行行为与安装包耗时仍未验证。本次有意移除接受时的落盘屏障，不把本地提交描述为已持久化。

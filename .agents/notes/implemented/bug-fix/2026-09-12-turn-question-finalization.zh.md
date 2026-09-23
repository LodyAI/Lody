# 让待答问题随其所属 turn 一同终止

Status: implemented
Translation: current

[English](2026-09-12-turn-question-finalization.md)

## 摘要

停止一个 Pi turn 会取消其原生问卷，却让 Lody 持久化的问题仍处于未回答且可操作的状态。turn 终结
现在会在它本就拥有的 assistant 条目中，为未回答的请求写入「已取消」结果。既有的历史订阅会释放
ACP 等待者，渲染层随之撤下问题卡片。该改动保留已回答的结果与其他 turn 中的请求，且不引入第二个
请求注册表，也不引入 adapter 专属的取消协议。

## 归属与范围

原生执行由 adapter 控制；用户交互及其历史由 Lody 拥有。`MessageHandler.finalizeACPState` 本就在
一次 `SessionDocument.updateHistory` 写入中 flush 更新并调用 `markAssistantTurnFinished`，那正是
assistant 条目的完成、取消与拆除的共同边界。它既有的 `turnId` 决定了条目，因此清理不会从当前可见
的问题推断归属，也不会取消会话中的每一个请求。

只有没有结果的请求会变为已取消。已记录的回答得以保留，重复终结也会保持既有的终态时间戳。权限
等待者的历史订阅看到的结果与 UI 使用的一致；无需额外的回调集合、标志位或前端状态。

一个请求可能在 Stop 已终结该工具条目之后才完成文档加载。权限富化会拒绝这个已终结的归属方，而不是
把请求挂到那里，也不会回退到更新的 turn。当富化报告请求未被持久化时，既有调用方会返回取消。

这修正的是由 Pi 暴露出来的既有宿主集成缺口。它不改变 Pi 的执行契约，也不改变已被接受的 Unix 硬
崩溃限制。它不引入针对「与 Stop 并发作答」的跨设备仲裁。

## 证据与验证

- 修复前，`history-permission-writer.test.ts` 中的回归测试在终结所属 turn 后观察到结果为 undefined。
- 修复后，真实的 SessionDocument/HistoryWriter 路径会持久化取消并通知历史订阅者。它保留了已回答的
  请求、更新 turn 中的待答请求、既有的未知工具内容与 CRDT 容器 id。
- 同一测试会拒绝一个针对已终结 turn 中工具的延迟请求；在加入准入检查之前，富化会错误地返回成功。
- 既有的终态时间戳与压缩终结测试仍然通过。
- 该集成测试不能证明完整的 Electron 交互验收。

本记录伴随 [Lody PR #605](https://github.com/LodyAI/Lody/pull/605) 与
[Pi PR #1](https://github.com/LodyAI/acp-extension-pi/pull/1)。

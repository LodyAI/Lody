# 隔离并合并 Streams token 刷新

Status: implemented
Translation: current

[English](2026-09-13-streams-token-refresh.md)

## 摘要

原先未授权回调会丢弃正在进行的刷新，导致多个 stream 放大 token 请求量。
Provider 现在共享刷新，并使用 SDK 提供的实际被拒绝 token，避免使替代 token 失效。
凭证变化同时隔离网络结果和异步缓存发布。协调只在 provider 内进行，托管签发端仍负责
授权与缓存隔离。

## 决策与证据

[草案规范](../../../../specs/streams-token-refresh.zh.md)定义契约。当前 Streams SDK
提供 `previousToken`，无需基于时间的猜测或重写传输层。没有引入全局 provider 池，
因为其身份和生命周期边界超出现有 provider。

持久缓存命名空间加入端点，密文仍绑定签发凭证。包括内存命中在内，无法解析当前登录时
拒绝返回 token。异步校验结束后、发布结果前必须立即同步检查代次：登录切换可能发生
在这两个微任务之间。

现有授权测试覆盖共享回调并发、迟到拒绝、凭证切换、旧请求完成、微任务发布竞争以及
端点和工作区隔离。托管缓存的实现和部署不属于公开仓库；可选的拒绝 token 字段向后兼容。

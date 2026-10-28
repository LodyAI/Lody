# 机器自行确认执行权限新鲜度

Status: implemented
Translation: current
PR: [#1991](https://github.com/LodyAI/Lody/pull/1991)

[English](2026-10-28-e2ee-execution-authorization.md)

## 摘要

已建立的加密连接和本地验证过的账本，都不能证明设备当前仍有执行权限。机器现在提供窄的执行准入接口，自行通过认证读取当前账本，再验证设备、成员及既有的非 Guest、非恢复设备规则。授权只存在内存，期限严格小于读取开始后的 15 分钟；重启后必须重新读取。刷新失败只拒绝等待中的新执行，不影响已有任务或本地操作。请求认证和持久执行去重仍由独立接入层负责。

## 决定与流程

本改动落实[白皮书](../../../../specs/e2ee/whitepaper.md)和[权限账本](../../../../specs/e2ee/permission-ledger.zh.md)中的执行权限新鲜度要求，补充 [journal 边界](../../proposed/architecture/2026-10-26-e2ee-realtime-journal.md)。journal 和内容认证都不授予执行权限。

```text
新执行（已认证的请求方公钥）
  authorizeExecution(workspaceId, requesterDevice)
    设备授权未过期？沿用原读取起点
    否则共用／启动当前工作区的认证账本读取
      本机设备凭据 -> 固定检查点的分页 -> runtime.ingest
    runtime.executionLedger -> 当前有效设备／成员／角色
    再查原读取期限 -> Authorized | Denied
  调用方仍负责请求验证、journal claim 和派发
```

`requesterDevice` 是小写 hex 签名公钥。Effect 返回 `_tag: Authorized | Denied`；拒绝原因为 `invalid-request`、`not-authorized`、`unavailable`、`closed`。工作区兼容层仅增加终止关闭检查，直接暴露原生 Effect。runtime 在既有串行边界内提供当前 VerifiedLedger 视图；签名、历史连续性和持久防回滚 pin 继续归现有 core。新鲜度时间和授权不写入这些存储。

接口通过本机设备凭据调用 `CloudE2eePort.getHistory`，拒绝落后于本地初始检查点的远端终点，以及分页检查点变化。core 的 `contentPermissions` 已表达同样的有效个人／机器设备与 Owner/Admin/Member 规则。每次准入都用最新本地验证视图重新判断，因此已知撤销或降权立即拒绝缓存授权；已知目标机器被撤销或移除时也拒绝准入。接口不接收转发时间戳、证明或连接状态。

## 所有权与失败范围

每个工作区及机器身份 Scope 拥有一个刷新 fiber，最多保留 1024 个请求设备授权。并发未命中共用刷新，包括不同设备；缓存授权仍按请求设备隔离。墙钟和单调时钟都必须满足从读取开始严格小于 15 分钟；时钟回退使缓存失效。淘汰只会提前要求重读，不会延长授权。

整次刷新最多等待 30 秒。取消单个等待者不取消其他请求的刷新。Scope 关闭取消刷新并清空缓存；不可取消的读取即使晚返回，也不能继续写入账本。既有云端读取本身也有 30 秒传输超时，读取没有远端写入副作用。失败或超时返回可重试的 `Denied/unavailable`，不设置工作区后台账本屏障、不调用 unavailable/removal 回调、不关闭副本或停止执行所有者。真实验证到的账本变化仍可能揭示撤销，已有所有者按自己的独立规则处理。

持久化授权、从响应到达重新计时、借用内容 token 缓存，都会削弱重启／读取起点约束。复用后台刷新还会把执行准入失败与收钥、工作区清理耦合。本次独立原生接口复用验证器和传输，同时避免这些副作用。不修改后端或线协议，也不迁移整个 Promise 工作区兼容层。

## 证据与限制

确定性测试扩展 `e2ee-runtime.test.ts`，使用真实签名账本与 SQLite、注入时钟及明确并发信号，覆盖计入读取耗时的 15 分钟精确边界、同一文件离线重启、设备／工作区隔离、并发成功／失败与重试、取消等待者、已知角色变化／撤销／移除、恢复与未知设备、回滚／损坏、超期读取、超时／晚回包和多页检查点一致性。受影响的 runtime/custody 测试、CLI 类型检查、限定范围的 lint/Effect 检查、格式、文档及公共／平台边界检查只证明本地实现。临时将新鲜度期限加倍后，15 分钟边界测试因错误返回 Authorized 而失败；恢复期限后通过。RPC 入口接入、请求完整性、journal claim 顺序、线上服务行为和真实网络／设备验收仍须分别完成；接口本身不启用执行派发。

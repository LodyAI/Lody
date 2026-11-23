# E2EE 恢复错误分类，不替换权限依据

Status: implemented
Translation: current
PR: [#1978](https://github.com/LodyAI/Lody/pull/1978)

[English](2026-10-27-e2ee-recovery-diagnostics.md)

## 摘要

本地权威历史和可信 pin 损坏此前只返回通用账本或存储错误；finalizer 失败也把只能重启的资源边界隐藏成通用 host 错误。宿主现在返回不同的安全恢复码，保留全部证据，并使失败工作区只封住自身。不执行远端历史重建、pin 重置或身份替换；显式归档重置与重新配对 UI 由 [#1970](https://github.com/LodyAI/Lody/pull/1970) 独立负责。

## 错误码与安全后续动作

| 错误码 | 含义及允许的后续动作 |
| --- | --- |
| `local-history-recovery-required` | 本地权威记录验证或 SQLite 文件损坏。未来显式远端重建必须用独立可信 genesis 和原可信 pin 验证完整来源，保留坏原件，停止同库原 writer 后原子发布副本。错误码本身不授予这些权限。 |
| `trusted-pin-unavailable` | 原可信 pin 无法解析。不得用服务器 head 或新空 pin 代替；无法证明原 pin 时走显式归档/重置及正常审批重新配对。 |
| `restart-required` | 一次性 Scope 关闭后 finalizer 失败。需重启 Lody 完成加密资源释放；不能清掉失败状态后创建第二个 writer。 |

已知原生不可用和客户端升级要求仍保留原区分。确定的 SQLite 损坏码（`SQLITE_CORRUPT`/`SQLITE_NOTADB` 或 node:sqlite 主码 11/26）与 busy、locked、权限等 I/O 分开。原始原因留在 main 诊断。schema 初始化失败会先关闭刚打开的连接，再传播原始失败；普通暂时性存储错误仍可重试。

## 隔离与资源归属

在 main `8529d3cf`，单个 workspace close 失败不会设置 account `closeFailed`，其他工作区原本就能继续使用。失败由原 entry 保留，后续重开现在明确提示重启，兄弟资源仍继续清理。只有整个 account Scope 关闭失败才设置账号封锁；清标记既不能复活已关闭 custody，也不能证明原生句柄已停止。因此保留这条安全限制，把通用 host 错误改为不带原始原因的明确重启提示。退出和登出仍按既有终止策略执行。

现有原生 host、Scope、Deferred 继续持有资源。关闭等待已接纳操作结束，再释放存储；重复关闭返回保留的失败结果。不新增 timer、账号/全局 map 或替代 owner，不改变迁移边界。

## 接入与限制

本组使用获准的错误码交接方式，避免重复 #1970 的身份/归档 owner 和 UI。新错误码的 UI 映射、远端重新验证及重建、真实钥匙串、安装版桌面和实体设备验收仍待完成。本 PR 特别不声称已经用健康原 pin 重建坏历史。验签、pin 和 fork 检查不变；有效但冲突的历史继续报冲突，不自动重置。

真实 crypto/SQLite 测试破坏原记录、pin 行和整个文件，验证坏原件/pin 字节不变、健康兄弟工作区可打开，并注入真实历史连接关闭失败。账号清理仍不能授权替代 owner，现在明确返回重启提示。这些测试在旧实现上失败；具体检查见 PR。

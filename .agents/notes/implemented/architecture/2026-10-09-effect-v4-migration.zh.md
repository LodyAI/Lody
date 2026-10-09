# 生命周期重构的 Effect v4 基线

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1070

[English](2026-10-09-effect-v4-migration.md)

## 摘要

生命周期重构需要先统一 Effect v4，再引入新服务。最底部的 PR 把工作区 Effect 和测试助手固定为
4.0.0，并迁移 CLI、renderer 和 ignore 包中已有的调用。针对 v4 的调度与资源释放差异，保留了
缓存清理错误的上报和发送准备的原有时间语义。进程创建、sandbox 所有权和调用方重构属于后续 PR，
不包含在本次基础迁移中。

## 范围与版本

#1070 以 main 为 base，后面依次是计划 #1057、进程基础 #1065、CLI 调用方 #1069、跨运行时调用方。
底部 PR 保留原有进程代码；后续新服务直接使用 v4。底部合入当前 main，后续层继承这次更新，各 PR 仍只描述自己的增量。

Effect 和 @effect/vitest 固定为 4.0.0，10 月 1 日发布，符合七天发布冷却期。
4.0.2 于 10 月 7 日发布，本次没有添加冷却期例外。测试助手需要 Vitest 5，因此 CLI 与 shared
升级到 5.0.2，CLI 的 coverage provider 同步升级。Vitest 5 支持 Node 22.12+、24.x、26+；
本地使用 Node 24，CI 使用 Node 22。产品运行时下限不变。

@prisma/config 内部的可选传递依赖仍是 effect 3.18.4，不强行覆盖第三方的兼容约定。
自有工作区六个直接使用方都解析到 4.0.0。

## 原语迁移

| v3                                       | v4                                                       |
| ---------------------------------------- | -------------------------------------------------------- |
| Context.Tag                              | Context.Service                                          |
| Layer.scoped                             | Layer.effect，可包含 scoped acquisition                  |
| Scope.extend / CloseableScope            | Scope.provide / Closeable                                |
| fork / forkDaemon / RuntimeFiber         | forkChild / forkDetach / Fiber.Fiber                     |
| Runtime.runFork(runtime)                 | Effect.runForkWith(services)                             |
| async / catchAll / either / zipRight     | callback / catch / result / andThen                      |
| Either.Left/Right                        | Result.Failure.failure / Success.success                 |
| failureOption / isInterrupted            | findErrorOption / hasInterrupts，Cause 为平面 reasons    |
| timeoutFail / TimeoutException           | timeoutOrElse / TimeoutError                             |
| Schedule.union / whileInput              | Schedule.min / Schedule.while，参数使用 input            |
| DurationInput / decode / Clock.sleep     | Duration.Input / fromInputUnsafe / Effect.sleep          |
| TestContext、根入口 TestClock、it.scoped | effect/testing 的 TestClock.layer、含 Scope 的 it.effect |

Semaphore 使用独立模块；ScopedCache 使用模块函数。Effect.yieldNow 是值，不再调用函数。

## 保留的行为

v4 默认延后启动 fork，发送资源用 forkIn 的 startImmediately 保留原有 650 毫秒准备边界。
4.0.0 的 ScopedCache.invalidateAll 不传播所等待 finalizer 的失败，缓存所有者在释放时收集错误，
完成全部清理后上报。原有 unsubscribe 失败断言保留。已有重连、超时、重试、会话行为保持不变，
本 PR 没有新进程树抽象或进程边界守卫。

## 验证与边界

依据 [官方迁移入口](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md) 和
[API 映射](https://github.com/Effect-TS/effect/blob/main/migration/v3-to-v4.md)，同时检查实际安装的
4.0.0 源码与声明，避免把上游 main 当成固定版本。

Vitest 5 用 execArgv 替代 poolOptions，内联 @effect/vitest 以共用 runner，CLI 的 src alias
与 tsconfig 对齐，构造函数 mock 改用可构造函数。异步断言等待可观察工作完成；资源关闭后先推进
零虚拟时间，清除完成通知，再保留原有“后续没有 attach”的检查。

重排后每层分别验证。此前合并的 v4 快照通过完整检查、格式、文档、冻结安装和 CLI/Electron 构建，
但这些结果不能代替中间层验证。检查只移除 authoring session 注入的 GIT_CONFIG__、GIT_EXEC_PATH
和 LODY_GIT__，让 Git 测试使用原生夹具而非作者环境里的包装器。

底部验证：类型与 lint 通过；CLI 3244 通过 / 4 跳过，shared 1258、components 4554、supervisor 49、
Electron 199。第一次完整检查到 Electron 时，发现 ignore-scripts 安装未恢复本地二进制；补齐同版本
二进制后重跑 Electron 通过，其余静态边界检查也通过。冻结安装、格式和文档检查通过。此环境问题
没有引入产品代码修复。

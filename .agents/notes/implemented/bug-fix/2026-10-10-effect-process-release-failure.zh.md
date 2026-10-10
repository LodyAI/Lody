# 进程 Scope 释放失败保留恢复租约

Status: implemented
Translation: current

[English](2026-10-10-effect-process-release-failure.md)

## 摘要

进程 Scope 未能终止进程树时，finalizer 会记录并吞掉 TerminationFailed，导致成功的 Effect body 仍然报告成功。原生 Git 迁移测试发现了这个下层缺口。现在 finalizer 显式失败，并通过 defect 携带恢复租约，将未解决的进程树交给接收方；Promise 边界保留全部租约及同时发生的 body 错误。恢复复用原有有界后端，只有确认进程树不存在才退役该代资源。此修复处理进程树释放报告，会话关停协调和 stdio 排空保证仍属于后续工作。

## 决定与所有权

[官方进程服务决定](../architecture/2026-10-09-effect-official-process-service.zh.md)保留 Lody 的有界后端。其 Scope finalizer 的 catch 分支将失败变成警告，释放报告仍有缺口。更换后端或另写终止循环不能修复这里的所有权。

finalizer 继续记录目标，并确保即使诊断日志抛错也保留 ProcessReleaseFailed defect。acquireRelease 的 release 没有 typed error 通道，因此 defect 保留在 Scope Exit 中，而不是报告释放成功。它私有持有原来的 ManagedProcess 和有界策略。isAlive 与 retryTermination 返回 Effect，无须重新提供 OS 服务，Scope 关闭后仍可使用。接收方保留租约直到确认不存在；重试失败仍保持存活状态，强制策略可立即与进行中的优雅重试收敛。观察到不存在后，Ref 退役租约，进行中的重试在每次探测和发信号时也检查该状态，避免向复用数字标识的新进程发信号。这不保证在尚未观察到不存在时避免标识复用。

Cause.squash 会选择主要错误，可能丢失同时发生的清理 defect。纯函数 squashProcessFailure 在存在其他主要失败或多个租约时，通过 ProcessCleanupFailed 保留每个 ProcessReleaseFailed reason。runPromiseSquashedLegacy 使用这一投影，没有新增 runner 或进程实现。清理成功时原有命令错误不变。原生 Effect 拥有者检查完整 Cause，兼容拥有者保留投影后的失败。重复 Scope.close 不能完成恢复。

[draft Spec](../../../../specs/process-scope-release.zh.md)说明接收方责任。本单元没有实现根注册表、自动重试服务或会话协调器。调用方丢弃失败仍可能放弃其责任，上层迁移必须替换这种处理。成功命令继续保留其刻意留在后台的 helper。

## 验证与边界

现有进程套件覆盖成功 body 的释放失败、重试失败后保留租约、优雅重试期间强制恢复、观察不存在后标识复用、多租约跨 Promise 边界，以及超时与释放同时失败。测试使用注入进程表、Deferred 就绪信号和 TestClock。原生 Git 新增的取消和释放失败用例发现该问题，保留在后续单元中。最终所属套件通过 40 个用例，shared 全部 113 个文件、1376 个用例以及 Electron 的 214 个用例通过。七项消融均被行为测试拒绝：吞掉 Scope 失败、丢弃 Promise 租约、不退役、伪造重试成功、日志失败丢失拥有者、进行中的重试忽略退役，以及屏蔽恢复等待的中断。基线和恢复后的源码通过。取消用例使用显式 Clock 等待和 TestClock；后者初次警告所用的 semaphore 会让被屏蔽的 sleep 进入可中断区域，因此只用 sleep 无法区分该消融。

最终 pnpm check 通过，包含完整 CLI 套件（317 个文件、3694 个用例通过，一个跳过）、shared、Electron 和全部守卫。类型感知 lint 零错误，format、format:check 和 docs check 通过。验证子进程隔离注入的 Git 配置、临时目录 package type 和锁目录覆盖，不修改用户全局配置。此前复现的 Roost signed-prefix 超时在最终完整运行中通过。这些不构成真实 Windows、委派 cgroup、打包或生产验证。Windows 根退出后后代的所有权仍需要单独的 Job Object 工作。租约恢复确认进程树不存在，不代表 stdio 已排空或全部外部资源已释放。

全仓检查基线为 main 339eede8592e237320e72f6f63c07aaa44591197。发布前刷新到 main 385f1a7278ad8a461919981494836fbdc9c980e6，期间文档/UI 改动未与本单元重叠。

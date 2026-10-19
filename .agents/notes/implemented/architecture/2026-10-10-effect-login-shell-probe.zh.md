# 原生登录 shell 探测与应用拥有的缓存

Status: implemented
Translation: current
PR: [#1397](https://github.com/LodyAI/Lody/pull/1397)

[English](2026-10-10-effect-login-shell-probe.md)

## 摘要

有限探测复用原生进程服务，CLI/Electron 共享缓存现在由应用 Scope 拥有的同一个
Effect 内核管理。本地等待者可以超时或取消而不停止其他等待者；应用关停才停止并
等待生产任务。释放失败保留进程恢复拥有者，确认清理前不能成功退出或替换。
剩余启动器 API 显式标记为 Legacy 执行边界；Session、Turn 与 Loro 生命周期仍待迁移。

## 探测策略

LoginShellHost 提供平台、环境快照和 shell 选择；LoginShellEnvironmentLive 捕获它
及官方进程 spawner，被动 loginShellEnvLayer 复用 Lody 有界后端。命令各自拥有 Scope。
候选顺序、登录与交互参数、bashrc 处理、分隔符、8 MiB 输出限制和注入变量恢复保持不变。
Clock 提供候选共用的 15 秒执行期限，进程释放另有上限。只有单独的已完成 CommandFailed
或 ENOENT 可以回退；不支持或不存在的 shell 返回 null；权限、流、超时与释放错误保留
完整 Cause。不引入第二套 spawn、输出收集或终止后端。

## 缓存与应用所有权

LoginShellCacheLive 使用 Ref/Semaphore，在拥有的子 Scope 中启动唯一生产 Fiber。
保留 Fiber 的 Exit，不使用 Promise 缓存或计时器。get、peek、warmup 组合 Effect；
get 可选的 Clock 超时只影响当前读取者。CLI 保留等待三秒后暂用空环境的行为，迟到
成功或失败都提供给后续同步与异步读取者。报告器只记录安全错误名称，不输出 shell
内容或环境。Electron 保留完整探测等待和禁用/null 行为。本地取消不会宣告进程已释放。

关停禁止新请求，先中断并等待生产任务，再关闭子 Scope；并发调用共享 Deferred 结果。
进程释放失败生成 LoginShellCacheShutdownFailed，并携带全部恢复租约。应用
makeApplicationRuntime 不依赖重复 Scope.close 等待第一次关闭：并发关闭者等待同一
结果。已完成但失败的关闭会重试转交的租约；恢复仍失败时保留原始 Cause。只有确认
前任已释放才允许绑定下一代。

CLI index 和 Electron startApplication 组合各自首个应用 runtime。CLI 的
fleet.shutdown 内仍保持会话停止、最终写入 flush、文档拆除顺序，随后关闭 shell
拥有者，再释放 host 租约；致命错误与一次性命令退出也等待释放。正常清理失败不能
以成功码退出。Electron 仍先征得 renderer unload 同意，再拆除服务；退出屏障等待
CLI 和原生应用拥有者，失败保留供下一次退出重试。初始化失败也先等待应用清理，
再以失败退出。现有显式强制退出策略保留；操作系统突然终止不能等待 Scope。
这些根只拥有此服务，不代表整个 Session、Turn 和 Loro daemon 已迁移。

调用方迁移后删除 probeLoginShellEnvLegacy 和 resetLoginShellEnvCacheLegacy。
剩余启动器访问器及应用绑定桥保留 Legacy 名称和 @deprecated；调用方直接获取原生
服务后删除。应用编排仍使用 Promise，所以应用关闭入口也显式叫 closeLegacy。
不保留第二套探测/缓存实现，也不提供隐藏的惰性 runtime。

## 依据与边界

使用已安装的 Effect/@effect-vitest 4.0.2 Context、Layer、Scope、Fiber、ManagedRuntime、
TestClock 源码及所属 Effect skill。真实临时 profile 和现有假 OS 表覆盖探测、进程树
清理与失败租约。新增行为覆盖等待者超时/取消、迟到结果/失败、并发清理、拒绝新请求、
真实进程服务的后代、失败关闭与重复恢复、首次同步读取、拒绝未释放代际替换、daemon
失败退出码，以及 Electron 退出与重试顺序。实验和验证隔离位于产品代码之外。不新增
Spec 或迁移 PR。本地 Linux 检查不代表 macOS/Windows 登录、Windows 根退出后的后代
归属、委派 cgroup、打包或生产验证。
[进程所有权](2026-09-27-effect-process-tree-layer.md) 与
[完整释放失败](../bug-fix/2026-10-10-effect-process-release-failure.md)
仍是前置依赖；安装、启动闸门、ACP、Session、Turn 和 Loro 是独立单元。

最终组合源码基于 main 45753fe61e0427043f5cb14c91b33e996ca376b0 验证：全仓类型检查与
type-aware lint 通过、零错误。完整 pnpm check 进入 CLI 测试后有 3753 项通过、1 项跳过，
剩下此前已复现的 Roost signed-prefix 30 秒超时，不宣称完整检查全绿。补验 Shared
112 文件 / 1415 项、Electron 216 项通过；8 个相关 CLI 套件 124 项、共享锁/shell/进程
套件 89 项通过。六项临时消融均被捕获：移除清理上限、重发已成功的旧 unlink、丢失文件
清理 Cause、随等待者取消共享生产者、丢失首次失败恢复拥有者，以及把 shell 释放失败
宣称成功。原始与恢复源码的锁/shell 套件分别通过 28/18 项；脚本不进产品代码。
格式、五项边界守卫和 docs check 通过。Git/PATH/临时目录/锁目录隔离只在验证子进程中
进行，不修改全局 Git、原工作区 HEAD 或 dirty 子模块 gitlink。验证期间主分支合入其它
改动，本轮保留明确验证的快照，不宣称已集成之后的分支尖。

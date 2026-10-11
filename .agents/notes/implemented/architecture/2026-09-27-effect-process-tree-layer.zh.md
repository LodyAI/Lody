# Lody 统一的 Effect v4 进程基础

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1065

[English](2026-09-27-effect-process-tree-layer.md)

## 摘要

各处独立的进程关停循环可能卡住、留下后代进程，或者把失败当成成功。现在进程核心直接建在 shared，
用 Effect v4 的服务、作用域和有上限的终止过程管理生命周期。ACP agent 与会话容器使用同一实现，
其余调用方在后续层迁移。Windows 的孤儿后代仍需要 Job Object；真实 Windows 与 cgroup 主机尚未验证。

本文的进程接口与 container 所有权已由
[官方进程服务决定](2026-10-09-effect-official-process-service.zh.md)进一步完善。

## 范围与 PR 归属

这份记录随尚未合并的 stack 重排，反映 v4 优先的交付顺序。
[v4 基线](2026-10-09-effect-v4-migration.zh.md) 属于 #1070；
[计划](../../proposed/architecture/2026-09-27-effect-turn-execution-and-acp-process-ownership.zh.md)
源自 #1057，由 #1355 恢复到 main，因为 #1057 合入了原基础分支。
#1065 负责进程核心、CLI 日志与容器、Session 关停、辅助 ACP agent、认证与历史探测
以及测试。核心直接位于 @lody/shared/node/process，后续 PR 只增加调用方，不再搬迁或复制实现。

## 所有权与终止

NodeProcess 是同步 OS 边界，通过 Context.Service 和 Layer.effect 提供。spawn 同一步挂好监听器，
Deferred 分别记录启动、退出、stdio 关闭与输出溢出。spawnScoped 通过 acquireRelease 管理资源，
shared 门面给尚未迁移的 Promise 调用方使用；CLI 的组合模块只提供日志和服务，不执行程序。

ProcessTree 区分发信号与整棵树是否存活。POSIX 进程组在首进程退出后继续跟踪，cgroup 容器保留
限制与统计。terminateTree 依次 SIGTERM、有上限的宽限、SIGKILL、有上限的退出确认；仍存活就返回
TerminationFailed。finalizer 中用 Clock 控制轮询上限，因为不可中断清理不能靠中断型 timeout 限时。
Windows taskkill 单独限时、检查退出码，根进程已退出时不再发信号。

spawn 失败没有可用 pid，绝不能向 pid 0 发信号。Windows 裸命令只从绝对 PATH 条目解析，不从仓库
cwd 查找。正常退出保留命令故意留下的后台进程；超时、中断或输出溢出则终止其进程树。
持锁命令保留 SIGTERM 宽限，让 git 清掉 index.lock；只读探测可以选强制策略。终止告警进入真实日志。

## Session 与失败处理

只有并发的终止调用共享结果；完成后再调用会重新清理。强制调用立即升级，即使温和关停尚未结束，
也不等待终端的温和清理。事件携带 agent 的退出信息；晚创建的 agent 仍会被清理。

需要证明进程已结束的调用方收到类型化错误。丢弃与归档路径捕获并告警，避免终止失败覆盖有效结果，
或跳过冷启动回退。已关闭的 cgroup 容器拒绝启动，强制终止通过 cgroup.kill 覆盖嵌套子组。

## 运行时边界

这里完成的是 OS 进程基础，不是整个 Session/Turn 重写。Session 与 ACP 类仍使用临时 Promise 门面，
daemon 级运行时留给后续会话资源阶段。此 stack 不引入 v3 进程实现，也不先在 CLI 建一份临时副本。

## 验证

重排后的每层分别执行 pnpm check、格式与文档检查。TestClock 与注入的进程表覆盖升级、强制取消、
仍存活的进程树和 finalizer 上限。真实隔离子进程测试通过明确的 readiness 信号等待，并清理整组，
包括 spawn 失败安全性与 unref 子进程不阻止父进程退出。

这些是本地证据；未验证真实 Windows、Linux cgroup 或签名安装包。taskkill 无法保留 Windows
父进程已退出后的后代身份，因此 [#429](https://github.com/LodyAI/Lody/issues/429) 仍待单独的
Job Object 工作补齐。

## 其余 CLI 调用方（#1069）

Git、worktree setup/GC、daemon 命令、MCP、preview、文件扫描、资源探测与 PTY 终止统一使用进程
门面。CLI 守卫拦截直接进程 API、启动进程的第三方依赖、动态导入和对子进程直接 kill。
独立生成脚本与 node-pty 启动是写明理由的例外；PTY 终止仍使用核心。

共享登录 shell 探测随 CLI 调用方引入。fallback shell 共用一个截止时间，printf 分隔符保留 PATH，
仅供探测的 tmux/update 变量恢复原值，多行环境值保持完整。CLI 启动仍在 3 秒后先放行，后台有上限
地完成探测。删除 CLI 的 shell-env 依赖；PTY hangup 后保留有上限的宽限再强杀进程组。

合并当前 main 后，#1069 也迁移新加入的 Simulator worker、原生服务、guest helper、
固定 xcrun 命令和 memory provider 命令。IPC 所有权及 guest EOF 释放仍由原模块负责，
进程树终止复用共享层；保留 main 的全局 Git 身份读取和已验证升级安装路径交接。

登录 shell 和 daemon runner 的超时回归测试改为确认启动后推进虚拟时钟，继续检查根进程与
后代退出，以及幸存进程必须报告失败。禁用命令进程组会使 shell 超时案例失败。
浏览器命令构造器测试仅重复其字面量映射，已连同仅供测试的导出删除；平台打开方式与 URL
参数传递不变。

## 跨运行时调用方（[#1348](https://github.com/LodyAI/Lody/pull/1348)）

Electron main、cli-supervisor、shared Node 辅助模块与 code-review-helper 使用继承的核心。
执行调用和测试 mock 使用 #1069 提供的 Legacy 后缀名称，不通过别名隐藏迁移边界；
返回 Effect 的核心 API 和资源所有权保持原实现。
守卫扩展到这些目录；新增进程能力必须进核心，不能在调用方复制。删除没有运行时使用方的手写
CJS 副本，把独有行为用例留在 TypeScript 模块。文件锁通过显式三态探测保留原有 EPERM 失效策略。

Electron 退出时同步开始发信号，Windows 也同步启动 taskkill。桌面 shell-env 使用继承的探测，
同时缓存成功与失败。supervisor 使用核心终止，不再跨重启保留永不结束的共享 Promise。
review 的 git 有上限，并使用 Windows PATH-only 解析。进程源码保持单文件、没有省略扩展名的
相对导入，以适配 Node strip-types 测试。

main 带入的桌面协议测试注入共享进程门面，并等待命令完成，保留启动时不覆盖现有公共协议
处理器、只有显式选择才更改它的行为断言。

初次重排后，每个代码层分别通过 pnpm check、冻结安装、格式和文档检查，最终源码与配置与此前
已验证的 v4 快照一致。当前 main 的集成继续保持该归属，并在每个合并后的代码层重新检查。
Simulator 和 memory provider 新增调用的迁移属于 #1069，不放进这一层。

集成当前 main 后，底层、进程层、CLI 层和跨运行时层各自通过 pnpm check、格式和文档检查。
最终层 CLI 3567 通过 / 4 跳过、shared 1330、components 4888、supervisor 52、Electron 211；
重建的各层也检查了冻结安装。
集成 main 后的 CLI 生产构建及发布包导入守卫也通过，包含迁移后的 Simulator worker。

supervisor 的升级终止与整组清理合为一个行为案例：IPC 请求被接受后，根进程在宽限期内
仍存活，之后强杀结束根进程与后代并发布 stopped 状态。禁用整组终止会使该案例失败。
删除重复的整组测试，以及 await 已完成 Promise 后再断言它已完成的冗余检查。

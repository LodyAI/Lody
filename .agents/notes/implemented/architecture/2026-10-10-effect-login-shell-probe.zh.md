# 原生登录 shell 环境探测

Status: implemented
Translation: current

[English](2026-10-10-effect-login-shell-probe.md)

## 摘要

共享登录 shell 探测此前用 Promise 循环执行 Legacy 进程入口，并将基础设施、超时及释放
失败折叠为环境缺失。LoginShellEnvironment 现在通过注入的 host 和官方进程服务组合现有
原生命令 API，候选 shell 共用 Clock 期限。CLI 与 Electron 经单一标记门面消费；剩余缓存
显式命名 Legacy，并保留失败而非缓存成功。这一有限探测迁移不代表后台缓存已具备应用所有权。

## 决定与职责

LoginShellHost 提供平台、环境快照与登录 shell 选择；LoginShellEnvironmentLive 通过
Layer.effect 捕获它和 ChildProcessSpawner。loginShellEnvLayer 只组合依赖及现有 Lody
有界进程后端；原生 probeLoginShellEnv 不执行程序。每次 runCommandOk 拥有命令 Scope；
取消传入命令并等待树及 stdio 清理，释放失败保留进程恢复拥有者。不新增 spawn、输出收集
或终止实现。

保留用户/默认 shell 后尝试 zsh/bash 的顺序、login/interactive argv、bashrc 处理、
delimiter、8 MiB 输出上限和从调用快照恢复探测专用环境变量。Clock 取代 Date.now，
所有 fallback 共用默认 15 秒命令等待预算。进程释放有独立的既有有界等待，因此执行期限
不代表释放所需总耗时也严格等于该期限。

只有单一已结束的 CommandFailed，或候选 executable 缺失 ENOENT 才允许 fallback。
已知候选耗尽后的不支持/缺失环境返回 null；Windows 不求值 POSIX host 环境。权限、
启动、stream/输出上限、超时和释放失败仍然失败，混合 Cause 原样传播，不变成可选缺失。
[draft 契约](../../../../specs/login-shell-environment-lifecycle.zh.md) 明确记录从静默
fallback 到可观察失败的变化。

probeLoginShellEnvLegacy 是此内核唯一 Promise 门面，转发入口 signal 并通过
runPromiseSquashedLegacy 保留全部进程租约。原来的无标记 Promise 名称现在表示原生
Effect 组合。CLI getLoginShellEnvLegacy / getCachedLoginShellEnvSyncLegacy 与
Electron getUserShellEnvCachedLegacy 显式表示尚存的 Promise 缓存拥有者；调用方不使用
隐藏 Legacy 的别名。应用拥有者接入服务后删除探测门面；消费方迁到应用拥有的原生缓存后
删除缓存入口。

CLI 既有三秒本地等待上限保留：探测仍 pending 时，早期调用可用空 overlay；迟到的成功
会更新后续读取。这与探测失败不同。早期失败拒绝；迟到失败以同一错误替换拒绝缓存，按安全
错误名报告，并让后续同步读取抛出。日志不含环境、profile 输出或原始错误。预热附拒绝
观察者，因为缓存自身记录失败。Electron 原本就保留拒绝 Promise，现在收到实际探测失败。

剩余模块 Promise、timer 和进程生命周期缓存还没有原生资源所有权。单个 CLI 等待者取消
不代表取消共享缓存；reset 是测试兼容操作；daemon 关停尚未 join 后台探测。不能由这个
叶子单元宣称统一 ManagedRuntime/根 Scope 已落实。

## 证据与验证

实现使用仓库固定的 Effect 与 @effect/vitest 4.0.2；核对了
[官方 v4 service/Layer 迁移文档](https://github.com/Effect-TS/effect/blob/main/migration/services.md)、
[Clock 服务源码文档](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Clock.ts)
及安装的 Context、Layer、Clock、TestClock、process 源码。原生测试使用 Deferred/TestClock
与既有内存 OS 表；真实临时 HOME profile 保留登录导出、多行值与 fallback。实际 CLI 缓存、
Session env、ACP runner/authentication 和 history 消费方一起验证：共享探测/进程套件
53 项、五个 CLI 消费套件 74 项通过。七项隔离消融被捕获：吞掉原生失败、重置 fallback
预算、替换墙上时钟、遗漏探测变量恢复、可变调用环境、将权限失败当可选缺失，以及缓存
失败变空成功。恢复后的原生/缓存套件分别八项/四项通过；实验脚本不进入仓库。

根 pnpm check 的全工作区类型与 lint 通过（零错误），CLI 3721 项通过、一项跳过，
唯一失败为 Roost signed-prefix 超时。使用精确 CLI/Shared 基线源码 9692d13、相同
两 worker 的 CLI/component 并发负载也复现该超时；单独运行基线用例通过。基线预览
另缺 SQLite 套件所需根 fixture 文件，属于预览配置问题，不是产品变化。不宣称完整
pnpm check 绿灯，也没有删除覆盖。补跑 Shared（113 文件、1383 项）、Electron
（215 项）及全部 i18n/import/platform/process/public 守卫通过。pnpm format、
format:check、所属源码/测试格式、开始 docs status 与结束 docs check 通过，无保护
主题改变。Git 污染仅在验证子进程隔离，不改用户全局配置。

本地 Linux 验证不证明真实 Windows、macOS 登录环境、委派 cgroup、打包或生产行为。
[进程层原决定](2026-09-27-effect-process-tree-layer.zh.md) 记录兼容 profile/本地等待行为；
[释放失败所有权](../bug-fix/2026-10-10-effect-process-release-failure.zh.md) 是失败投影的
前置依赖。安装器、启动闸门、连接/会话拥有者与原生应用缓存仍是独立单元。

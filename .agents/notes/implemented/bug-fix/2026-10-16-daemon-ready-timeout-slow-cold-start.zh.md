# 按慢速冷启动设定 daemon 就绪超时

Status: implemented
Translation: current

[English](2026-10-16-daemon-ready-timeout-slow-cold-start.md)

## 摘要

`lody daemon start` 和远程升级交接原本只给新 watchdog 的 Worker 固定 30 秒来进入
ready。在一台较慢的 Linux 机器上，新版本冷启动约需 40 秒。每次远程升级都安装成功，
随后超时：启动方杀掉新进程并重启旧版本，每次重试都重复这一循环。现在该时限改为
三分钟的卡死兜底。已在运行旧版本的 watchdog 执行交接时仍使用自身的 30 秒上限，
这类机器需要用修复后的版本手动重启一次。

## 决策

就绪握手本来就会在真实失败时结束：Worker 不可重试的退出会产生 `error` 报告，
runner 退出会关闭就绪管道。因此超时只覆盖一种情况：启动仍在运行，却始终没有
ready。它必须容纳慢硬件、冷加载模块、启动期网络请求以及可重试启动的退避。
最重要的是，交接超时会丢弃一次已经成功的升级。三分钟是实测冷启动时间的数倍，
同时仍能为交互式 `daemon start` 和交接限定卡死启动的最长等待时间。

放弃的方案：

- **基于 fd 3 通道进度的截止时间。** runner 只有在 Worker 的本地 IPC 服务启动后才能
  看到 `startupStage`，而那发生在对时等待和大部分冷启动之后，因此无法观察早期进度。
  增加进度行也需要显式开启：旧版本的启动方只接受第一行 JSON，会把进度行判为无效
  报告，并清理一个健康的新进程。
- **用环境变量覆盖超时。** 远程交接继承旧 watchdog 的环境，用户实际上无法设置它；
  它还会为本应正确的默认值增加一个隐藏配置面。

升级日志显示 `startup.sync_time` 约 20 秒。该 span 从启动开始计时，并与认证和 CLI
检测并行；事件循环空闲后，其请求在 5 秒后中止。因此这 20 秒更可能反映启动繁忙，
而不是时间服务器缓慢。本次改动不调整对时顺序。

## 验证与限制

`daemon-shared.test.ts` 用假计时器覆盖两种情况：45 秒后报告 ready 的 runner
继续存活；始终不报告的 runner 会连同 Worker 一起终止，并报告为 `timeout`。
使用旧的 30 秒值时，慢启动用例失败。未在真实慢速设备上验证。本修复无法改变
已在运行旧版本的 watchdog 内部的时限，见
[CLI 恢复步骤](../../../../apps/cli/README.md#daemon-upgrades-and-autostart)。
相关决策：[绑定已验证的升级安装](2026-10-03-daemon-upgrade-installation.zh.md)。

# Daemon 升级安装与交接

Status: draft
Translation: current

[English](daemon-upgrade-installation.md)

## 场景与职责

从 npx 缓存启动的 daemon 可能成功安装全局新版，却仍从旧缓存入口重启。
远端升级必须将 watchdog 及其 Worker 都切换到本次升级产生的安装位置。

生命周期安装器沿用全局 npm 安装，通过同一 npm 环境解析全局包位置，并验证
包身份、位于包内的声明入口、安装版本及入口实际输出的版本。指定精确版本时
必须一致；`latest` 使用安装包的具体版本。旧 argv 和 PATH 中的 `lody`
都不能作为升级目标位置。

旧 Worker 停止并释放 Host 租约后，watchdog 使用上述明确入口交接，保留
daemon 参数及现有环境清理规则。只有替代进程的 Worker 就绪，且替代 watchdog
报告的版本与已验证版本一致，才算升级完成。版本缺失或不一致均视为交接失败，
恢复前必须停止并等待本次启动的替代进程退出。普通启动继续兼容旧版就绪回执。

安装、验证、就绪是不同结果。验证或交接失败不得记录为升级成功。现有所有权
与重启恢复规则保持有效；恢复不会回滚 npm 已修改的包文件。生命周期 ACK
投递遵循 [ACK 契约](machine-lifecycle-ack.md)。

## 现有部署

用户维护的自启动脚本及服务定义不由安装器管理。它们必须指向目标 Node/npm
安装下的稳定全局启动器，而不是缓存或特定版本入口。Windows 和 WSL 要分别
修正。已经运行旧交接代码的 watchdog 需要从修正后的启动器进行一次重启。
不提供版本化就绪回执的目标不能完成此远端验证交接；启动这类旧版本需要明确
执行本地重启。

## 证据与限制

- [安装器](../apps/cli/src/lib/machine-lifecycle.ts)、
  [交接](../apps/cli/src/commands/daemon-runner.ts)及
  [就绪边界](../apps/cli/src/commands/daemon-shared.ts)。
- [合成安装与交接测试](../apps/cli/src/lib/machine-lifecycle-upgrade.test.ts)。
- [自启动恢复说明](../apps/cli/README.md#daemon-upgrades-and-autostart)。
- 尚未验证真实 registry 安装及 Windows/WSL 实机行为。

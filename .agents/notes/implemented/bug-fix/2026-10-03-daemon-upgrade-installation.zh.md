# 把 daemon 更新绑定到稳定的恢复进程

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1228
Supersedes: [Windows npm shim](../../archived/bug-fix/2026-09-08-windows-daemon-upgrade.zh.md)

[English](2026-10-03-daemon-upgrade-installation.md)

## 摘要

从 npx 缓存启动的 daemon 可能安装成功后仍启动旧入口；已安装版本和正在运行版本是两回事。
托管更新采用固定 SEA 监护进程和签名的不可变版本，固定进程始终持有 Host 运行权，
观察到实际替换后才提交结果。额外的普通 Node 增加首次下载体积；无法确认进程终止时停止恢复。

## 决策和原因

之前的 npm bin 校验修正了目标路径，却仍依赖用户 npm 环境、原生安装脚本和两个进程的运行权交接。
Windows 命令脚本还需要解释器；修补转义解决不了安装所有权问题。
通过 PATH 查找入口、修改共享的全局包，都不适合作为远程更新机制。

固定入口从现有数据目录读取持久化的版本选择和操作记录，使用按摘要缓存的官方普通 Node，
启动经过校验的实体 CLI 文件。外部 Agent JS、钥匙串辅助程序和 Worker 仍需要普通 Node；
SEA 只能运行内置入口。原生模块保持签名字节不变。SEA 自身还嵌有 Node，因此首次下载含两份运行时。
复用现有监护进程，避免新增 Rust 启动器及重叠的重启职责。

所有旧 npm 监护进程都需要一次本地迁移和外部服务入口修正，下载新代码不能改变旧进程的协议。
不会静默重写用户服务。固定入口也只通过显式安装器替换，避免另一个自我替换的恢复循环。

准备时旧 Worker 继续服务；只有确认排空和进程终止后才启动下一个写入者。
同一操作 ID 绑定同一目标和选择；下载确认不能代表更新成功，必须核对实际运行身份。
回滚同时保存结果和下次启动选择。网络断开不能证明本地失败。
Windows 自动更新和加密生命周期操作，在对应所有权、授权边界完成前保持不支持。

## 证据和限制

[安装契约](../../../../specs/daemon-upgrade-installation.md)、
[打包说明](../../../../apps/cli/scripts/sea/README.md)、
[签名版本测试](../../../../apps/cli/src/lib/managed-daemon-release.test.ts)和
[原生夹具](../../../../apps/cli/scripts/sea/native-acceptance.mjs)覆盖不同边界。
产物探针不能代替完整 Agent 验收或正式签名验证。
POSIX 进程组是协作式所有权，不是阻止恶意子进程逃逸的容器。

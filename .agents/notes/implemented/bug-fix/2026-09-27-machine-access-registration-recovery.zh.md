# 后端失败后恢复机器访问注册

Status: implemented
Translation: current

[English](2026-09-27-machine-access-registration-recovery.md)

## 摘要

托管服务的机器访问注册失败后，运行中的 daemon 不会再次尝试注册。创建 Session 和列出远端项目时，命令先过滤被拒绝的机器，因此可能把已知机器报成不存在。现在 daemon 用有上限的指数退避重试注册，两个命令也会针对选中的机器报告真实的访问拒绝。本修复不解决托管服务本身的 5xx，也不会在验证拒绝时放行访问。

## 问题与决定

`MessageHandler.activateRemoteServices` 原先只注册一次，并记录失败。瞬时失败会一直保留，直到重启或其他无关的注册路径发生。重试从一秒开始，翻倍增长，最多五分钟；成功后停止，cleanup 时取消。现有的进行中 Promise 与成功缓存继续避免重复请求。

Session 创建和项目列表命令此前只在获准机器中选择目标。机器元数据仍存在而访问注册被拒绝时，就出现机器不存在或没有获准机器的误报。现在识别被拒绝的精确机器 ID，再检查访问结果，之后才能读取项目或派发 Session。未知 selector 在仍有获准机器时报告 `Machine not found`，候选只含获准机器；完全没有获准机器时保留 `No authorized machines are available in this workspace`。已知但被拒绝的 ID 报出拒绝原因，仅对 `machine_not_registered` 提示查看 daemon 日志。

## 范围与验证

Issue 报告 daemon 多次启动时托管服务重复返回 5xx。该服务故障无法在公开 CLI 仓库复现或修复。本改动处理重试与本地诊断，保持访问检查失败时禁止继续。定向测试覆盖注册失败后的恢复、创建目标的错误分类和远端项目列表的拒绝；命令检查结果记录在 PR 或贡献交接中。

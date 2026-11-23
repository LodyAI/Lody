# 文档维护的异步 Git 执行

Status: implemented
Translation: current

[English](2026-10-15-docs-async-git.md) | 中文

PR：[LodyAI/Lody #1582](https://github.com/LodyAI/Lody/pull/1582)（Draft）。

## 摘要

受限执行环境中的文档状态与检查命令失败，尽管 Git 返回了正确内容和退出码 0：Node 同步管道捕获同时报告 EPERM。工具现在在 status、check、diff、确认以及 CLI 入口的完整调用链中等待异步 Git 执行。二进制输出与失败诊断得到保留，只有无索引内容比较接受退出码 1。受限环境验证覆盖修复后的命令；EPERM 对应的底层宿主或运行时原因仍未确定。

## 证据与职责

这是[文档维护工具](../../proposed/process/2026-09-05-human-reviewed-spec-maintenance.zh.md)的子进程实现修复，不改变 Spec 审批或 SHA 复核政策。

在同一受限 Linux 工作区、Node 24.22.0 下，使用管道捕获的 `spawnSync('git', ['rev-parse', 'HEAD'])` 返回正确 HEAD、status 0、signal null、空 stderr，同时返回 code 为 EPERM 的错误，`execFileSync` 因此抛错。忽略 stdio 或把输出写入普通文件的同步调用返回 status 0 且没有错误；使用管道捕获的异步 `execFile` 也返回正确字节且没有错误。这把观察到的故障定位到同步捕获路径，但尚不能确定具体系统调用或沙箱、运行时组件。没有通过更改权限策略让脚本通过。

`scripts/docs/git.mjs` 负责保留原始字节的异步执行和失败分类。`main.mjs` 等待所有依赖调用，包括主题检查、已提交清单验证、临时 diff 清理、基线提交比较和入口错误处理。单个主题出错仍不会隐藏健康主题。恢复基线 blob 失败时保留底层 Git 诊断。

## 决策与取舍

用 Promise 封装回调式 `execFile`，固定 Buffer 编码，保留指定 cwd，并关闭 stdin。保留原有每个输出流 1 MiB 的捕获上限；超限必须拒绝，不能返回部分复核数据。保留 Node 的启动、退出和 signal 错误以及捕获的 stdout/stderr。只有内容比较显式接受退出码 1，终止或捕获失败时仍拒绝。

仅因 status 为 0 就忽略 EPERM 会把可能不完整的捕获视为可信。保留同步执行、改用临时输出文件会给每次 Git 调用增加文件捕获与清理。异步执行避免这两种选择，代价是导出的报告与命令函数改为返回 Promise；现有调用者和 owning suite 一起迁移。这个独立 Node 工具不需要 Effect 依赖，也不扩展到无关生命周期迁移。

## 验证与限制

文档 suites 的 29 项测试通过，使用真实 Git 仓库验证二进制 blob、特殊路径的 NUL 分隔输出、相同与不同内容的 diff、非零退出与 stderr、命令不存在、权限拒绝、signal 终止以及 stdout/stderr 超限。CLI 流程覆盖确认、内容漂移、只读 diff、重新确认和启动错误的退出传播。宿主另有嵌套 Node 向 socket stdio 写入受限的问题，因此合成可执行文件使用同步写入，CLI 输出写入普通文件。本机使用 `node --test --test-isolation=none scripts/docs/*.test.mjs`，避免默认测试运行器的子进程输出受到同一限制。

真实 `pnpm run docs status` 在原有约束下成功。`docs check` 可以执行，保留基线中指向缺失子模块内容的 82 个断链错误、68 个警告，没有注册的 SHA 主题；这些不是子进程故障。本次文档编辑前后的错误与警告列表完全一致。已尝试根级 `pnpm check` 与 `pnpm format`，分别因缺少 `tsgo` 与 `oxfmt` 中止。局部测试和格式检查复用已存在、与锁文件一致的 TypeScript 5.9.3 和 Oxfmt 0.65.0，没有安装或更改依赖。

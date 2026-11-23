# 读取两份用户级 Git 身份配置

Status: implemented
Translation: current
拉取请求：[#1517](https://github.com/LodyAI/Lody/pull/1517)

[English](2026-10-12-xdg-git-identity.md)

## 摘要

已有的 `~/.gitconfig` 会让 `git config --global` 忽略仅存在于 XDG 配置中的身份。
通过隔离的 include 文件按 Git 的优先级读取两份用户级配置，由 Git 负责解析和条件包含。
仓库、系统和命令级身份仍不进入这次查询。此修改只处理
[#1451](https://github.com/LodyAI/Lody/issues/1451) 中的本地配置读取问题。

## 决策与限制

私有临时目录持有 include 文件，并在 `finally` 中删除。
与标准输入不同，真实文件可供 `hasconfig` 条件再次读取；额外的 include
会占用 Git 包含深度限制中的一级。显式 `GIT_CONFIG_GLOBAL` 或 `HOME` 缺失或为空时
保留原生 global 查询。Author/committer 环境变量优先级和五秒命令超时不变。

保留同步调用方和共享进程适配层；迁移整个 Session 生命周期超出了此修复范围。
Owner/profile 策略和凭据选择不变，包括独立的
[策略查询期限](2026-10-11-git-identity-preflight-deadline.zh.md)。

## 验证

真实 Git fixture 覆盖 XDG/home 优先级、包含、显式覆写、环境身份以及
仓库和命令级身份隔离。实际检查结果和平台限制记录在 PR 中。

# 清除已完成的 Session Fork 操作时保留 Loro 根容器

Status: implemented
Translation: current

[English](./2026-09-08-session-fork-operation-clear.md)

## 摘要

新 worktree Session Fork 能完成 Git worktree 和 ACP runtime 的准备，却会在最终提交阶段以 `Map value must be an object` 失败。原因是 `SessionDocument.setForkOperation(undefined)` 通过 loro-mirror 删除可选的 `forkOperation` 根 map，而 Loro 根容器不能被删除。Session 文档现在通过 Loro API 清空该 map 并提交变更；schema 解析仍会把空 map 视为操作不存在。

## 决策与范围

Fork 操作的写入和阶段迁移继续通过 loro-mirror 完成。操作完成时直接清空现有根 `LoroMap` 并提交，保留容器以供后续 Fork 复用。这个改动不改变 Session 协议或 schema，也不需要数据迁移。

回归测试使用真实的 Loro 文档和 Mirror，覆盖首次创建、迁移到 `committing`、成功清除，以及后续操作复用。

## 证据与替代方案

桌面 `LODY-FORK-001` 用户旅程在创建 worktree 和 ACP 后，于删除根容器时抛错。把值替换为 `{}` 也能绕过根容器删除，但该值不符合声明的操作结构，并依赖关闭更新校验。清空底层 map 符合 Loro 的根容器模型，同时保留读取时的 schema 校验。

聚焦的 Loro 回归测试和 Session Fork 服务测试均已通过。桌面旅程的实现仍位于另一个尚未合并的 E2E 分支，因此本分支尚未重跑该旅程。

本修复仅处理 `forkOperation`。其他可选根容器如需清除，也应遵循相同模型，但不在这次已观测缺陷的范围内。

# 使用 Oxfmt 格式化包

Status: implemented
Translation: current

[English](2026-09-15-adopt-oxfmt.md)

## 摘要

此前包格式化使用 Prettier，而路由生成可能与已提交的路由树产生纯格式差异。
本改动将 hyoban 的[社区 PR #330](https://github.com/LodyAI/Lody/pull/330)
适配到当前 main，把现有包格式化命令和组件路由树生成统一到 Oxfmt。
ACP 子模块仍独立管理工具；本次不做全仓格式重排，也不恢复发布产物。

## 决策与边界

根 Oxfmt 配置保留原有通用风格，以及 Electron 不使用分号的覆盖规则。
CLI、Electron 和 cloud-api 的格式化命令使用该配置。
组件包执行 `tsr generate && oxfmt src/routeTree.gen.ts`，并直接声明 Oxfmt 依赖，
确保嵌入父工作区时不依赖公共根包被安装。父工作区采用此版本时须同步依赖锁文件。

也可以仅用 Prettier 规范化路由树，但采用社区改动后会继续保留第二套格式化工具。
Electron 暂时保留 Prettier 依赖以兼容现有 ESLint 配置，不再用于格式化命令。
源码改动仅为机械格式化，不改变运行时行为或 ACP 子模块指针。
分支历史保留了原始社区提交。

## 验证

CLI、Electron 和 cloud-api 的现有递归 Oxfmt 检查通过。连续两次路由生成的
SHA-256 一致，且与已提交的路由树无差异。工作区类型检查、类型感知 lint、
全部 112 项 Electron 测试及文档检查通过。完整 `pnpm check` 在类型检查、lint
及前面的测试通过后，于组件测试阶段停止，不能视为全量通过。
未验证发布；此改动本身不会发布或修复已创建的发布产物。

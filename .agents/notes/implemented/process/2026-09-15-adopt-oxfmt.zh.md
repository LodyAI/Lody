# 使用 Oxfmt 格式化包

Status: implemented
Translation: current

PR: [#737](https://github.com/LodyAI/Lody/pull/737)

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
确保嵌入父工作区时不依赖公共根包被安装。CLI、Electron 和 cloud-api 同样直接
声明 Oxfmt，不能依赖不存在的父级命令。父工作区采用此版本时须同步依赖锁文件。

也可以仅用 Prettier 规范化路由树，但采用社区改动后会继续保留第二套格式化工具。
Electron 暂时保留 Prettier 依赖以兼容现有 ESLint 配置，不再用于格式化命令。
工具包默认启用 `prettier/prettier`，因此显式关闭该规则，避免编辑器的 ESLint
自动修复再次使用另一套格式化工具改写 Oxfmt 输出。
源码改动仅为机械格式化，不改变运行时行为或 ACP 子模块指针。
分支历史保留了原始社区提交。

## 验证

CLI、Electron 和 cloud-api 的现有递归 Oxfmt 检查通过。连续两次路由生成的
SHA-256 一致，且与已提交的路由树无差异。最终工作区类型检查、快速检查及
全部 118 项 Electron 测试通过。完整 `pnpm check` 通过了 3,690 项组件测试和
2,835 项 CLI 测试，但因五项 gh-shim 测试失败而非零退出：无关的临时目录包
将生成的 CommonJS shim 当成 ESM。使用隔离的 CommonJS 临时目录后，该文件
未经修改的七项测试全部通过。最新 main 集成的 82 项草稿相关测试也通过。
这些是组合验证结果，不能宣称完整命令零退出。
公共冻结锁文件校验通过；真实父工作区安装后，四个使用方都能解析 Oxfmt 0.65.0。
修复包内依赖归属并关闭 Prettier ESLint 规则后，独立复审没有剩余 P0/P1。
未验证发布或打包产物内容；此改动本身不会发布或修复已创建的发布产物。

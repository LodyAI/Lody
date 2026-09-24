# 依赖发布时间隔离

Status: implemented
Translation: current
English: [2026-09-13-dependency-release-age.md](2026-09-13-dependency-release-age.md)
PR: https://github.com/LodyAI/Lody/pull/629

## 摘要

此前依赖解析可以在版本发布后立即采用该版本，因此兼容性升级可能在生态系统尚未来得及发现受损或有缺陷的制品时就将其引入。pnpm workspace 现在对新解析的包版本设置七天的最短发布时间。现有锁定版本继续作为已审查基线，后续 lockfile 更新只会选择已完成隔离期的版本。

## 背景

Vite 8 兼容性 Stack 表明，功能 CI 和端到端覆盖并不能提供发布时间保护。由于 workspace 没有解析器级延迟，Vite 8.3.0 在发布不到两天时就进入了升级分支。相比要求每位依赖升级作者手工计算发布时间，仓库级统一设置更可靠。

## 决策

在 `pnpm-workspace.yaml` 中将 pnpm `minimumReleaseAge` 设置为 `10080` 分钟，即完整七天；pnpm 为根 workspace 解析版本时统一应用该策略。

主线 lockfile 已锁定的三个 Loro Mirror 2.3.2 包使用精确版本例外进行祖父化，避免启用策略后追溯性地否定已接受的 lockfile。这些例外不适用于后续 Loro 版本；任何更宽泛的例外都必须通过单独且明确的决策，并提供与供应链风险相称的证据。

该策略约束未来解析，不追溯已经进入 lockfile 的条目的历史发布时间。因此，当前兼容性 Stack 使用实施决策时已经完成七天隔离期的最新稳定版 Vite 8.2.2，而不保留发布时间不足七天的 Vite 8.3.0 锁定项。

## 验证

仓库固定使用的 pnpm 10.20.0 会读取此 workspace 设置。冻结 lockfile 安装验证启用策略后仍保留已审查基线，Vite 升级分支的依赖解析验证会选择符合隔离期的 Vite 8。精确的 Loro 例外只匹配主线中已经存在的版本。常规静态检查、构建、测试和完整桌面端端到端检查仍负责验证兼容性；发布时间是额外的供应链门槛，不能替代这些检查。

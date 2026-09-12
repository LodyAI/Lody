# 仅发布 changelog 的 tag 发版

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/609

[English](2026-09-11-changelog-only-releases.md)

## 摘要

此前推送 tag 会构建三个桌面平台并发布安装包与更新源，而 macOS 签名凭据成为所有发布的闸口。
替代方案改为开启一个草稿状态的 app 版本同步 PR，并创建仅含 changelog 的源码 release。tag
不可变，因此 manifest 同步单独落到默认分支上。既有的二进制 release 保持完好，但新 release
不再提供安装包或自动更新产物。

## 决策与限制

[工作流](../../../../.github/workflows/release.yml)接受稳定版本 tag，枚举各 app 的直接
manifest，并使用单个版本专属的 PR 分支。它只需要仓库内容与 pull-request 写权限；不需要
依赖、submodule、签名凭据、打包 runner 或 release environment。重跑时它会保留既有的 release
notes 与产物。它刻意不移动 tag，也不直接向受保护的默认分支提交版本变更。

lockfile 存放的是 app 依赖而非 app manifest 版本，因此这个纯版本操作不会改动 pnpm-lock.yaml。
被取代的版本 PR 需要维护者关闭，且仓库必须允许 Actions 创建 pull request。验证在本地覆盖了
版本编辑操作与工作流结构；真实的 tag 发布未被执行。该嵌套 checkout 缺少依赖且 submodule 未
初始化，限制了完整的仓库检查。

意图：[tag releases](../../../../specs/tag-releases.md)。

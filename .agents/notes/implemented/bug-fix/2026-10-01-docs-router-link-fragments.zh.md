# 将文档 URL 的 fragment 与 RouterLink 路径分开

Status: implemented
Translation: current

[English](2026-10-01-docs-router-link-fragments.md)

[Draft PR #1194](https://github.com/LodyAI/Lody/pull/1194)

## 摘要

Introduction 的 Daemon Mode 链接渲染成 `#daemon-mode/`，点击或刷新时无法定位
ID 为 `daemon-mode` 的标题。MDX 输入与 URL helper 已保留正确的 fragment，
问题是 Fumadocs 适配层将完整 href 当作 router 的 pathname。修复在该边界分别
传递 pathname、search 和 hash，保留静态站点的目录 URL 并恢复锚点导航。
回归检查覆盖两个语言、两种视口下的真实生产 HTML、水合导航及刷新；尚未验证
部署后的行为和其他浏览器引擎。

## 证据与决定

核对的 main 为 `7d502f3d99fdcdbbdd43d032c6d903d4ed497e04`。检查已有开放 PR，
并搜索文档 fragment、anchor 和 Daemon Mode 后，未发现有效的已有修复。
历史基线 `5073ef39` 与当前 main 都使用 `/docs/cli#daemon-mode`；修改 MDX 会
掩盖实际渲染缺陷。
发布前 main 为 `93545f01b69cb0c98ddd3f19d46540decd95a007`，新增的 CLI 修改
与本项无关，站点源码与核对的基线相同。

生产 Introduction 渲染 `/docs/cli/#daemon-mode/`。点击后真实标题仍在视口下方，
直接访问 `/docs/cli/#daemon-mode` 则能滚到标题。本地 `siteHref` 输出正确的
`/docs/cli/#daemon-mode`，但已安装 router 的 `buildLocation({ to: ... })`
输出包含 `#daemon-mode/` 的 pathname，hash 为空。

[目录 URL 决策](2026-09-30-public-site-directory-urls.zh.md)在
[PR #1146](https://github.com/LodyAI/Lody/pull/1146) 合并，其 helper 正确保留
fragment。`trailingSlash: 'always'` 暴露了适配层原有的错误假设：认为 `to`
接收完整 href。TanStack 将 `to` 按路径解析，并在最后一段追加目录斜杠，即使
该段实际包含 fragment。只检查 helper 的测试无法发现这个集成问题。

`SiteFrameworkLink` 先规范化 href，再将 `url.pathname` 传给 `to`，将 router
解析后的 query 传给 `search`，将去掉 `#` 的 fragment 传给 `hash`。绝对站内
href 保留原生导航，[App 路径导航边界](2026-09-14-docs-web-app-links-leave-the-spa.zh.md)
继续生效。目录策略与 MDX 的含义不变；这是实现缺陷修复，不改变 Spec 意图。

关闭 trailing slash 会与 canonical 和静态主机 URL 冲突。修改单个 MDX 链接
不能修复其他 fragment。所有文档改成原生导航会丢失现有客户端导航，因此修复
限定在适配层。

## 验证

- 54 项现有站点测试通过，包括 helper 的 fragment/query 用例。
- 站点 typecheck 和生产构建通过。
- 生产浏览器 `anchors` 阶段覆盖 Introduction 真实链接、编码后的中文 Project
  锚点、表格中的纯 fragment 链接、标题视口位置、客户端 document 保留和刷新。
  Query 变体只替换所服务模块中的合成 MDX 链接输入，再使用真实适配层和 router
  验证编码后的 query 值与中文 fragment，不改变线上内容、账号或后端数据。
- 修复适配层之前，8 项真实链接用例都因 fragment 多余斜杠失败；修复后完整
  12 项桌面/移动视口用例通过。
- 完整浏览器套件记录 307 项通过，4 项失败在本项之外：未修改的中文 Introduction
  绝对下载 URL 缺少目录斜杠；移动端 blog selector 选中隐藏导航；两项中文导航
  用例期待的正文链接不在未修改的中文 Introduction 中。Fumadocs 的外部下载
  链接不经过此适配层。这些结果如实记录为失败，不在本次修复中处理。完整执行
  exit code 为 1；单独 anchors 阶段以 exit code 0 完成。
- 根 `pnpm format` 通过。根 `pnpm check` 因其他 workspace 缺少依赖而在
  typecheck 停止；文档检查报告未初始化 ACP 子模块造成的 62 项既有断链，
  本次修改的文档没有错误。
- 公开边界检查报告 9 项无法解析的 workspace 引用，均指向这些未初始化的 ACP
  子模块；没有修改 package manifest。

仅安装站点的冻结依赖时，需要通过被忽略的 worktree 本地链接提供现有隐式
样式依赖 `tw-animate-css@1.4.0`，没有修改 manifest 或 lockfile。浏览器检查
使用本地 Chromium，阻止外部请求，以可观察状态同步而不使用固定 sleep。
Safari、Firefox、真实移动设备和部署后的版本不在已完成的验证范围内。

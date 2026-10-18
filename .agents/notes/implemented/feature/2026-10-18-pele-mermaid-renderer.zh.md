# 用 Pele 渲染聊天中的 Mermaid 图

Status: implemented
Translation: current

[English](2026-10-18-pele-mermaid-renderer.md)

## 摘要

聊天里的 Mermaid 代码块原来由 beautiful-mermaid 渲染，它只支持流程图、状态图、时序图、类图、ER 图和 XY 图，
所以 agent 写的甘特图、饼图、思维导图、时间线和 git 图都只能显示源码。Pele 是 Obsidian 的 MIT 渲染器，
零依赖，覆盖 Mermaid 12.1 的全部内置类型；它在同一个懒加载边界后替换了原渲染器，受保护的图表 chunk 从 gzip 约 492 kB 降到 251 kB。
代价是这个库 2026-10-06 才首次发布，因此以经过审查的精确版本绕过七天隔离期引入。

## 决定

- 只替换渲染器。`markdown-mermaid.ts` 懒加载 `pele` 并调用 `render()`；对被拒绝的输入（语法错误、ZenUML、
  超出大小限制）和运行时加载失败，保留原来的源码清单兜底。激活、手势、全屏查看器和下载控件都不变。
- 不使用 `mount()` 和 `enableZoom()`：它们会监听容器宽度并自带缩放，与
  [内嵌视图契约](../../../../specs/mermaid-inline-view.md)冲突。
- 设置 `links: false` 和 `images: false`：否则 Pele 会输出 `click` 链接和远程节点图片（已用合成图验证），
  本地桌面端不能因 agent 输出而发起请求或跳转。
- Pele 通过 `--pele-*` 自定义属性设置主题。Lody 把明暗调色板写进根 `<svg>` 的 `style`，
  因此下载的 SVG、PNG 导出（从 `data:` 图片绘制）和全屏克隆都保留颜色。按 mermaid.js 形状写的主题表和仅用于类型的 `mermaid` 依赖已删除。
- `pele@1.6.0` 列入 `minimumReleaseAgeExclude`。其 tarball 没有依赖和安装脚本，bundle 中没有 `fetch`、`eval`
  或 `new Function`。后续版本仍受隔离约束。
- 删除了把 `@meowdown/react` 私有 beautiful-mermaid chunk 指向 Lody 那份副本的 Vite resolver。
  自 Tasks 产品移除后没有代码再导入 meowdown，beautiful-mermaid 只作为它未被使用的传递依赖保留。

## 备选方案

- 保留 beautiful-mermaid：API 面更小，但不支持的类型仍只能显示源码。
- 回到 mermaid.js：类型完整，但它就是 #46 移除的 1.6 MB 运行时，而且依赖 DOM 渲染。

## 证据与局限

- `tests/markdown-mermaid-plugin.test.ts` 现在使用真实的 Pele：覆盖流程图、饼图和甘特图渲染、根节点调色板声明、
  链接与图片移除，以及兜底路径。
- `electron-vite build --mode oss` 通过了 Mermaid 懒加载边界守卫；`mermaid-deps` 压缩后 677 kB、gzip 251 kB，
  而同样方式打包的 beautiful-mermaid 加 elkjs 为 1.63 MB / 492 kB。
- 在 Chromium 页面中用真实模块渲染了十二种图表类型的明暗两种主题以及导出路径。布局与 mermaid.js 不同，
  beautiful-mermaid 也是如此。没有在应用内跑 Storybook 或 E2E。
- Pele 很新、迭代很快；升级时需要做同样的 tarball 审查。

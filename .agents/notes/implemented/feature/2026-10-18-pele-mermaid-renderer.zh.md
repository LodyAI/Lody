# 用 Pele 渲染聊天中的 Mermaid 图

Status: implemented
Translation: current

[English](2026-10-18-pele-mermaid-renderer.md)

## 摘要

聊天里的 Mermaid 代码块原来由 beautiful-mermaid 渲染，它只支持流程图、状态图、时序图、类图、ER 图和 XY 图，
所以 agent 写的甘特图、饼图、思维导图、时间线和 git 图都只能显示源码。Pele 是 Obsidian 的 MIT 渲染器，
零依赖，覆盖 Mermaid 12.1 的全部内置类型；它在同一个懒加载边界后替换了原渲染器，受保护的图表 chunk 从 gzip 约 492 kB 降到 251 kB。
图表颜色现在取自应用自己的配色 token，不再使用一套与 Vesper 石墨色界面不协调的独立 slate 配色。
代价是这个库 2026-10-06 才首次发布，因此以经过审查的精确版本绕过七天隔离期引入。

## 决定

- 只替换渲染器。`markdown-mermaid.ts` 懒加载 `pele` 并调用 `render()`；对被拒绝的输入（语法错误、ZenUML、
  超出大小限制）和运行时加载失败，保留原来的源码清单兜底。激活、手势、全屏查看器和下载控件都不变。
- 不使用 `mount()` 和 `enableZoom()`：它们会监听容器宽度并自带缩放，与
  [内嵌视图契约](../../../../specs/mermaid-inline-view.md)冲突。
- 设置 `links: false` 和 `images: false`：否则 Pele 会输出 `click` 链接和远程节点图片（已用合成图验证），
  本地桌面端不能因 agent 输出而发起请求或跳转。
- 颜色取自应用配色。Lody 只有 Lody Light 和深海 Vesper 两套配色，原来手选的 slate 颜色与两者都不匹配
  （Vesper 的石墨色界面里出现海军蓝 `#0b1120` 底色）。Pele 读取 `--pele-*` 自定义属性，markdown 样式表在图表块上
  把它们映射到配色 token：文字用正文前景色，边框由主色和次要前景色混合，连线标签的底色是图表块填充色的不透明版本。
  以后调整配色会直接作用到图表，不用再同步第二份色表；切换明暗无需重新渲染，因此 SVG 缓存和 markdown 组件映射不再依赖明暗模式。
  固定配色表和仅用于类型的 `mermaid` 依赖已删除。
- 图表数据系列保留 Pele 自带的分类配色。应用里现成的色相 token 只有状态色，它们带有含义（标成 "danger" 颜色的扇区会被误读），
  也不是为并排区分而设计的。
- 离开图表块的副本会在图表所在位置解析颜色，并声明到自己的根节点上：SVG/PNG 下载和移到 portal 中的全屏克隆。
  通过在 canvas 上画一个像素，把 `hsl()`/`color-mix()` 统一成普通 `rgb()`，让其他 SVG 工具也能读取。
  分享图片（snapdom）自己计算样式，不需要额外处理。
- `pele@1.6.0` 列入 `minimumReleaseAgeExclude`。其 tarball 没有依赖和安装脚本，bundle 中没有 `fetch`、`eval`
  或 `new Function`。后续版本仍受隔离约束。
- 删除了把 `@meowdown/react` 私有 beautiful-mermaid chunk 指向 Lody 那份副本的 Vite resolver。
  自 Tasks 产品移除后没有代码再导入 meowdown，beautiful-mermaid 只作为它未被使用的传递依赖保留。

## 备选方案

- 保留 beautiful-mermaid：API 面更小，但不支持的类型仍只能显示源码。
- 回到 mermaid.js：类型完整，但它就是 #46 移除的 1.6 MB 运行时，而且依赖 DOM 渲染。

## 证据与局限

- `tests/markdown-mermaid-plugin.test.ts` 现在使用真实的 Pele：覆盖流程图、饼图和甘特图渲染（输出中不含固定配色）、
  链接与图片移除、兜底路径，以及下载和全屏克隆所用的颜色固化。
- `electron-vite build --mode oss` 通过了 Mermaid 懒加载边界守卫；`mermaid-deps` 压缩后 677 kB、gzip 251 kB，
  而同样方式打包的 beautiful-mermaid 加 elkjs 为 1.63 MB / 492 kB。
- 在 Chromium 页面中用真实模块渲染了十二种图表类型。另一个页面通过 Lody 自己的主题变量生成流程和样式表中的真实映射，
  套用了 Lody Light 和 Vesper，并检查了下载图片、全屏克隆（以及一个未固化颜色、退回 Pele 浅色默认值的对照组）和 snapdom 截图。
  布局与 mermaid.js 不同，beautiful-mermaid 也是如此。没有在应用内跑 Storybook 或 E2E。
- Pele 很新、迭代很快；升级时需要做同样的 tarball 审查。

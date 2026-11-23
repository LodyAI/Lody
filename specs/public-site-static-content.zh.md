# 官网静态内容

Status: draft
Translation: current

[English](public-site-static-content.md)

读者或爬虫打开 landing、博客文章或文档 URL 时，初始 HTML 必须包含标题、描述、
canonical URL、正文和普通导航链接。JavaScript 用于增强体验，阅读和跟随链接不应
依赖它。中英文页面遵循相同规则。手机导航必须使用原生折叠菜单，在 hydration
完成前及禁用 JavaScript 时仍能展开并跟随链接。

官网将每个已发布 URL 构建为静态 HTML。预渲染失败必须使构建失败；未知 URL 保持
现有 HTTP 404 和 noindex 行为。公共内容不需要请求时运行的应用服务器。

直接访问页面时，客户端必须在 React 接管文档前完成当前路由及文章内容的加载。
初始化或必需模块失败时保留静态文档及元信息，不显示框架错误界面，也不反复刷新。
首页的可选动画和产品演示必须隔离自身渲染错误，确保周围静态文案仍可阅读。

初始化失败时，搜索、主题切换、动画等 JavaScript 交互可以不可用。本约定不承诺
恢复 hydration 成功之后的所有运行时异常，也不保证 HTML/CDN 故障期间的可用性。
客户端路由跳转的容错与直接访问静态页面分开处理。

## 实现证据

- `site-docs/vite.config.ts`：枚举 URL 的静态预渲染。
- `site-docs/src/client.tsx`：接管文档之前的准备阶段。
- `site-docs/components/optional-enhancement.tsx`：可选功能错误隔离。

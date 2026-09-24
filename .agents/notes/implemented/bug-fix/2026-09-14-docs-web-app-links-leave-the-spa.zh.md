# 文档中指向 Web 应用的链接必须离开站点 SPA

Status: implemented
Translation: current

[English](2026-09-14-docs-web-app-links-leave-the-spa.md)

## 摘要

`/docs/quickstart` 上的「Sign in to Lody」卡片会渲染出 404，尽管
`https://lody.ai/login` 本身返回 200：公共站点是一个 TanStack Start SPA，Fumadocs
渲染的每个链接都走 TanStack 适配器的 `Link`，而客户端跳转到 `/login` 在 `src/routes`
中匹配不到任何路由，于是根路由的 `notFoundComponent` 把站点 404 画在了一个并不属于本站
的路径上。只有整页刷新才能到达 Web 应用，这也是落地页、定价页和下载页上手写的 `<a>`
从未暴露该问题的原因。修复没有只改那张卡片，而是把边界显式化：`site-root-provider.tsx`
现在向 `RootProvider` 传入 `Link` 覆盖实现，对 `APP_OWNED_PATHS` 中的路径输出普通锚点，
其余行为与原生适配器完全一致，因此任何指向 `/login` 的内容链接都会执行真正的文档跳转。
这份列表就是契约——将来 Web 应用接管 `lody.ai` 的其他路径时，必须先登记再在内容中链接。

## 决策

### 404 来自客户端路由，而不是托管主机

`content/docs/{en,zh}/(getting-started)/quickstart.mdx` 用 `<Card href="/login">`
渲染第三张卡片。Fumadocs 的 `Card` 会把 `href` 交给 `fumadocs-core/link`，后者把不带协议
的值视为站内链接并委托给框架适配器；`fumadocs-core/framework/tanstack` 渲染的是
`<Link to={href} preload="intent">`。`components/site-root-provider.tsx` 通过
`fumadocs-ui/provider/tanstack` 的 `RootProvider` 安装了该适配器，所以 hydration 之后这
张卡片就是一个路由链接。`/login` 没有对应的文件路由，跳转最终落到根路由的
`notFoundComponent`（`SiteNotFound`），读者就看到地址栏是 `/login`、页面是 404。

预渲染 HTML 本身没有问题——它输出的是 `<a data-card="true" href="/login">`，而
`curl https://lody.ai/login` 返回 200 和 Web 应用的 SPA 文档（`<!-- __LODY_APP_SPA__ -->`）。
故障只存在于 hydration 与点击之间。落地页、定价页、下载页的 CTA 指向同一个 `/login`
却正常，因为它们是手写锚点，路由器根本看不到。

### 路由器只能接管本站拥有的路由

可推广的结论不是「这张卡片要换个 prop」，而是 `lody.ai` 由两个应用提供服务，本站路由器
不得拦截另一个应用的路径。因此站点现在自己提供适配器的 `Link`：

```tsx
const APP_OWNED_PATHS = ['/login'];
// 命中 APP_OWNED_PATHS 的 href -> <a href>，其余 -> <RouterLink preload=… to=…>
<RootProvider components={frameworkComponents} …>
```

这一次性覆盖了 Fumadocs 渲染的所有链接——文档 `Card`、普通 MDX 链接，以及其他由该库经适配器
渲染的链接——并保持在当前标签页跳转，与下载页浏览器一行的 `target: '_self'` 一致。内容作者
照常书写 `/login`；`site-docs/components/AGENTS.md` 与 `site-docs/content/AGENTS.md` 记录了
规则：新的 Web 应用路径必须先登记进 `APP_OWNED_PATHS`，才能在内容中链接。

### 备选方案

- **在两个 MDX 文件里写 `<Card external href="/login">`。** 这是库支持的用法、改动只有一个
  单词，但 `fumadocs-core/link` 会给 `external` 配上
  `target="_blank" rel="noreferrer noopener"`，登录会在新标签页打开——这是没人要求的交互
  变化——而且下次在 MDX 中写 `[…](/login)` 仍会 404。`Card` 的 props 类型是
  `HTMLAttributes<HTMLElement>`，其中没有 `target` 和 `rel`，想恢复同标签页行为就得加类型断言。
- **在本站新增 `/login` 路由。** 预渲染出的 `out/client/login/index.html` 会发布到同一主机，
  可能遮蔽 Web 应用自己的 `/login`。这属于破坏边界，而不是修路由，故否决。
- **把未匹配的客户端跳转改写成 `window.location` 跳转。** 那样连真正写错的文档 URL 也会被
  甩给 Web 应用，掩盖预渲染 `/404` 本应暴露的坏链接。

## 验证

- 修改前在生产环境复现：用 Chromium 打开 `https://lody.ai/docs/quickstart/`，点击
  「Sign in to Lody」后，点击前写入 `window` 的标记仍然存在，说明没有发生文档跳转；地址变为
  `https://lody.ai/login`，正文是「404 Page not found」。对同一 URL 执行 `curl` 返回 200 和
  Web 应用文档，由此可以确定问题出在客户端路由。
- 在 `site-docs` 中运行 `corepack pnpm exec tsc --noEmit` 通过（需要先构建
  `acp-extension-*` 子模块包，否则 `packages/shared` 无法解析
  `acp-extension-dsh/capabilities`）。
- `corepack pnpm run build` 构建成功；`out/client/docs/quickstart/index.html` 中该卡片预渲染为
  `<a href="/login" data-card="true" …>`，没有额外的 `target` 或 `rel`。
- 在静态主机（`PORT=4183 pnpm --filter @lody/site-docs preview:static`，等价于 Cloudflare
  Pages）上，同样的点击在 `/docs/quickstart/` 和 `/zh/docs/quickstart/` 都会清除该标记——即真正的
  文档跳转，且停留在当前标签页——而相邻的「Download the desktop app」卡片标记仍在，保持客户端跳转。
  本地主机没有 `/login`，因此返回 `404.html`；这里验证的是浏览器离开了 SPA，而不是 Web 应用返回什么。

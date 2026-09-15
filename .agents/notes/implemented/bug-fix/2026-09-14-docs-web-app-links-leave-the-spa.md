# Docs links into the web app must leave the site's SPA

Status: implemented
Translation: current

[中文](2026-09-14-docs-web-app-links-leave-the-spa.zh.md)

## Abstract

The "Sign in to Lody" card on `/docs/quickstart` rendered a 404 page even though
`https://lody.ai/login` itself answers 200: the public site is a TanStack Start SPA,
Fumadocs routes every link it renders through the TanStack adapter's `Link`, and a
client navigation to `/login` matches no route in `src/routes`, so the root
`notFoundComponent` painted the site's 404 over a path this site does not own. Only
a hard reload reached the web app, which is why the hand-written anchors on the
landing, pricing and download pages never showed the bug. The fix names the boundary
instead of patching the one card: `site-root-provider.tsx` now passes a `Link`
override to `RootProvider` that emits a plain anchor for paths in `APP_OWNED_PATHS`
and otherwise behaves exactly like the stock adapter, so any content link to `/login`
performs a real document navigation. The list is the contract — a future `lody.ai`
path served by the web app has to be added there before content links to it.

## Decision

### The 404 came from the client router, not from the host

`content/docs/{en,zh}/(getting-started)/quickstart.mdx` links the third card with
`<Card href="/login">`. Fumadocs' `Card` forwards any `href` to `fumadocs-core/link`,
which treats a value without a scheme as internal and delegates to the framework
adapter; `fumadocs-core/framework/tanstack` renders `<Link to={href} preload="intent">`.
`components/site-root-provider.tsx` installs that adapter through
`RootProvider` from `fumadocs-ui/provider/tanstack`, so after hydration the card is a
router link. `/login` has no file route, so the navigation resolves to the root route's
`notFoundComponent` (`SiteNotFound`) and the reader sees 404 with `/login` in the URL bar.

The prerendered HTML is innocent — it ships `<a data-card="true" href="/login">`, and
`curl https://lody.ai/login` returns 200 with the web app's SPA document
(`<!-- __LODY_APP_SPA__ -->`). The bug only exists between hydration and the click.
The landing, pricing and download CTAs point at the same `/login` and work because they
are hand-written anchors that the router never sees.

### The router may only claim routes this site owns

The generalisable statement is not "this card needs a different prop"; it is that
`lody.ai` is served by two applications and the site's router must not intercept the
other one's paths. So the site now supplies the adapter's `Link`:

```tsx
const APP_OWNED_PATHS = ['/login'];
// href in APP_OWNED_PATHS -> <a href>, everything else -> <RouterLink preload=… to=…>
<RootProvider components={frameworkComponents} …>
```

This covers every Fumadocs-rendered link at once — docs `Card`s, ordinary MDX links,
and anything else the library routes through the adapter — and it keeps the navigation
in the same tab, matching the download page's browser row (`target: '_self'`). Content
authors keep writing `/login` normally; `site-docs/components/AGENTS.md` and
`site-docs/content/AGENTS.md` carry the rule that a new web-app path must be registered
in `APP_OWNED_PATHS` before content links to it.

### Alternatives

- **`<Card external href="/login">` in the two MDX files.** Supported by the library
  and a two-word diff, but `fumadocs-core/link` pairs `external` with
  `target="_blank" rel="noreferrer noopener"`, so sign-in would have opened a new tab —
  a UX change nobody asked for — and the next `[…](/login)` written in MDX would 404
  again. Card's props are typed as `HTMLAttributes<HTMLElement>`, which has no `target`
  or `rel`, so restoring same-tab behaviour would have needed a cast.
- **Adding a `/login` route to this site.** A prerendered `out/client/login/index.html`
  would be published to the same host and could shadow the web app's own `/login`.
  Rejected as a boundary violation rather than a routing fix.
- **Rewriting unmatched client navigations into `window.location` assignments.** It
  would also fix genuinely missing docs URLs by bouncing them to the web app, hiding
  broken links that the prerendered `/404` is supposed to surface.

## Verification

- Reproduced on production before the change, driving Chromium against
  `https://lody.ai/docs/quickstart/`: a marker set on `window` survives the click on
  "Sign in to Lody", so no document navigation happened; the URL becomes
  `https://lody.ai/login` and the body reads "404 Page not found". `curl` on the same
  URL returns 200 and the web app document, which isolates the fault to the client router.
- `corepack pnpm exec tsc --noEmit` in `site-docs` passes (the `acp-extension-*`
  submodule packages must be built first, or `packages/shared` fails to resolve
  `acp-extension-dsh/capabilities`).
- `corepack pnpm run build` completes; `out/client/docs/quickstart/index.html`
  prerenders the card as `<a href="/login" data-card="true" …>` with no `target` or
  `rel` added.
- Against the static host (`PORT=4183 pnpm --filter @lody/site-docs preview:static`,
  the Cloudflare Pages equivalent), the same click now discards the marker — a real
  document navigation, same tab — on `/docs/quickstart/` and on `/zh/docs/quickstart/`,
  while the neighbouring "Download the desktop app" card keeps the marker and stays a
  client navigation. The local host has no `/login`, so it answers with `404.html`;
  what is verified here is that the browser leaves the SPA, not what the web app returns.

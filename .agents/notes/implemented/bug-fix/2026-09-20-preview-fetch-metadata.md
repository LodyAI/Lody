# Preview navigation Fetch Metadata

Status: implemented
Translation: current

[中文](2026-09-20-preview-fetch-metadata.zh.md)

## Abstract

Astro development pages can work in an external browser but show a plain 403
through managed preview. Node fetch overwrites navigation mode with `cors` while
retaining the browser's cross-site metadata, turning an allowed navigation into
an apparent cross-site subresource request. The shared preview HTTP header builder
now removes browser Fetch Metadata only for navigation requests. Origin and
subresource metadata remain intact; no project security configuration is disabled.

## Decision and evidence

Both the local proxy and remote tunnel use `buildLocalPreviewRequestHeaders`
before fetching the bound loopback target. The fix handles `navigate` and
`nested-navigate` there, removing Site, Mode, Dest and User metadata for the
server-side hop. Node will still generate its own Mode header. Simply forwarding
the original Mode cannot work with fetch, and removing metadata for all requests
would unnecessarily discard cross-site subresource checks.

[Astro's middleware](https://github.com/withastro/astro/blob/main/packages/astro/src/vite-plugin-astro-server/sec-fetch.ts)
allows requests without Site metadata and navigations, but responds with
`Cross-origin request blocked` for cross-site subresources. Existing preview
capability authorization and target binding still run before upstream access.

Regression coverage uses Node HTTP requests (not fetch) to supply browser
navigation headers through the actual local proxy to an Astro-style guard.
It covers both navigation modes, rejection of `cors`/`no-cors` cross-site
subresources, and rejection of missing preview credentials before upstream access.
This is a local HTTP fixture, not validation on the reporting user's installed
Astro version or a packaged Electron application.

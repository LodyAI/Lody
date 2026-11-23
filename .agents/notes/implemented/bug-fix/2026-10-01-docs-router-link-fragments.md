# Keep documentation URL fragments outside RouterLink paths

Status: implemented
Translation: current

[中文](2026-10-01-docs-router-link-fragments.zh.md)

[Draft PR #1194](https://github.com/LodyAI/Lody/pull/1194)

## Abstract

Introduction's Daemon Mode link rendered `#daemon-mode/`, so clicking or refreshing
it could not find the heading with ID `daemon-mode`. The MDX input and URL helper
already preserved the correct fragment; the Fumadocs adapter passed the entire href
as a router pathname. Splitting pathname, search, and hash at that boundary keeps
the static host's directory URLs while restoring fragment navigation. Regression
checks exercise real production HTML, hydrated navigation, and refresh in both
locales and viewport sizes; deployed changes and other browser engines remain unverified.

## Evidence and decision

The checked main was `7d502f3d99fdcdbbdd43d032c6d903d4ed497e04`. No effective
existing fix was found among open PRs or searches for documentation fragments,
anchors, and Daemon Mode. The source at historical baseline `5073ef39` and current
main both contained `/docs/cli#daemon-mode`; changing that MDX would hide the
rendering defect.
The publication-time main `93545f01b69cb0c98ddd3f19d46540decd95a007` adds only
unrelated CLI changes; the site sources remain identical to the checked base.

On production, Introduction rendered `/docs/cli/#daemon-mode/`. After clicking,
the real heading remained below the viewport, while a direct visit to
`/docs/cli/#daemon-mode` scrolled to it. Locally, `siteHref` returned the correct
`/docs/cli/#daemon-mode`, but the installed router's `buildLocation({ to: ... })`
returned a pathname containing `#daemon-mode/` and an empty hash.

The [directory URL decision](2026-09-30-public-site-directory-urls.md), merged in
[PR #1146](https://github.com/LodyAI/Lody/pull/1146), correctly preserves fragments
in the helper. Its `trailingSlash: 'always'` policy exposed the adapter's existing
assumption that `to` accepts a complete href. TanStack resolves `to` as a path and
adds the directory slash to its last segment, even when that segment is a fragment.
Helper-only tests could not detect this integration failure.

`SiteFrameworkLink` now normalizes the href, then supplies `url.pathname` as `to`,
the router's parsed query as `search`, and the fragment without `#` as `hash`.
Absolute site hrefs retain native navigation. The
[app-owned navigation boundary](2026-09-14-docs-web-app-links-leave-the-spa.md)
continues to apply. The directory policy and MDX contents retain their meaning;
this repairs an implementation bug, without changing Spec intent.

Disabling trailing slashes would conflict with canonical/static-host URLs.
Patching one MDX link would leave other fragments broken. Native navigation for
all docs would discard existing client navigation, so the fix stays at the adapter.

## Verification

- Existing site tests: 54 passed, including helper fragment/query cases.
- Site typecheck and production build passed.
- The `anchors` production-browser phase covers Introduction's actual link,
  the encoded Chinese Project anchor, fragment-only table links, heading viewport
  position, preserved client documents, and refresh. Query variants change only
  synthetic MDX link input in served modules, then exercise the real adapter and
  router with percent-encoded query values and a Chinese fragment. No live content,
  accounts, or backend data are changed.
- Before the adapter fix, all eight actual-link cases failed on the extra fragment
  slash. The corrected suite passes all 12 cases across desktop/mobile viewports.
- The full browser suite records 307 passed cases and four failures outside this
  fix: the unchanged Chinese Introduction's absolute download URL lacks a slash,
  the mobile blog selector selects hidden navigation, and two Chinese navigation
  cases expect an article link absent from the unchanged Chinese Introduction.
  The external download anchor bypasses this adapter in Fumadocs. These checks
  are reported as failures, not fixed in this change. The full run exited 1;
  the standalone anchor phase completed with exit code 0.
- Root `pnpm format` passed. Root `pnpm check` stopped in unrelated workspace
  typechecking with missing dependencies; the document check reports 62 existing
  links into uninitialized ACP submodules and no errors in this change's documents.
- The public-boundary check reports nine unresolved workspace references into
  those uninitialized ACP submodules. No package manifest changed.

A site-only frozen installation requires the existing implicit stylesheet
dependency `tw-animate-css@1.4.0` supplied through an ignored worktree-local link;
no manifest or lockfile changed. Browser checks use local Chromium, block external
requests, and wait for observable state rather than fixed sleeps. Safari, Firefox,
real mobile devices, and a deployed build are outside the completed verification.

# Remove startup route restoration

Status: implemented
Translation: current

[中文](2026-09-29-startup-chat-landing.zh.md)

## Abstract

Default entry could reopen the previously visited conversation, carrying its work
view query parameters into a new launch. Entry now selects the workspace's chat
landing. The route store and lifecycle listeners are removed, and legacy saved
routes no longer influence the boot shell. This gives up automatic return to prior
work; explicit navigation and requested window targets retain their destinations.

## Decision and evidence

[Startup intent](../../../../specs/app-startup-landing.md) owns the new behavior.
The local entry already selected chat landing; the shared authenticated entry had
two last-route redirects. Both are removed, along with the authenticated route
tracker, storage module, and obsolete sign-out/workspace-removal cleanup calls.

The [boot shell decision](../feature/2026-09-26-boot-shell-first-paint.md) still
applies except that a default entry cannot infer a sidebar from a saved route.
Until a workspace path is known it shows the mark alone. Its inline script and
both Electron CSP hashes change together. Legacy storage is inert; no migration
or preference switch is needed.

## Verification

The former storage suite is replaced by entry-routing regression coverage with a
legacy session URL in both storage scopes, exercising cached, resolved, and local
workspace entry. Boot-shell coverage checks that a saved route is ignored.
Electron CSP checks pass (5 tests), and direct execution of the boot script passes
3 assertions for legacy storage and explicit workspace paths. Changed TypeScript
files were formatted with Oxfmt 0.65.0; `git diff --check` passes.
The worktree has no installed dependencies: component tests, route generation,
`pnpm check`, and repository-wide formatting could not run. Documentation checking
reports 62 broken links, all pointing into absent ACP submodules; none concerns
this change. No packaged-app acceptance is claimed.

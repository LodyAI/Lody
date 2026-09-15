# Preview annotation availability

Status: draft
Translation: current

[中文](preview-annotation-availability.zh.md)

A user opening a managed preview can view and interact with the page even when
the optional annotation runtime is absent, blocked, or delayed. Missing annotation
must not cover the content, report that page loading failed, or prevent reload.
Actual network, authorization, and proxy failures remain failures.

The iframe owns document loading. Runtime messages enable annotation and report
navigation information, including best-effort toolbar loading hints for in-frame
navigation. Native iframe load independently clears loading; runtime hints never
gate document readiness or content visibility.
A late valid handshake may enable annotation without reloading the page.

The runtime accepts control only from its actual parent window and locks the
first accepted origin for that document. A previous page's referrer is not proof
of the parent's identity. An unrelated window cannot establish this binding.

The CLI validates proxy reachability separately from annotation injection. A
forwarded application error page can still be viewed. If adding instrumentation
alone would exceed the response limit, serve the original page without it;
oversized original responses remain rejected.

## Evidence

- [Surface](../packages/components/src/components/sessions/managed-preview-surface.tsx)
- [Runtime](../packages/shared/src/visual-annotation-injected-script.ts)
- [Proxy readiness](../apps/cli/src/preview/preview-tunnel-readiness.ts)

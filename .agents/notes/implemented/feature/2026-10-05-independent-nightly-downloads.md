# Independent Nightly downloads

Status: implemented
Translation: current

[中文](2026-10-05-independent-nightly-downloads.zh.md)

## Abstract

A shared desktop and Android manifest makes Android downloads depend on desktop publication. The page now loads `version.json` and `android-version.json` independently, showing each platform group’s own version and retry state. A failed endpoint leaves the other group available. This requires the publisher to produce the separate Android manifest; parser tests do not establish deployed availability.

## Decision and evidence

This changes the shared-manifest presentation from [Android downloads](2026-10-04-nightly-android-download.md), preserving its immutable filename and HTTPS-root validation. Each group owns its request, timeout and state; Android has no desktop minimum-version requirement. Keeping one shared request would preserve the failure coupling. The [draft contract](../../../../specs/desktop-channel-execution.md) records the independent availability requirement.

The six parser tests pass, including standalone Android metadata, mismatched versions and unsafe URLs. Scoped strict TypeScript checking and an isolated React render smoke test also pass: either endpoint may fail or retry without hiding the other group, and different versions render correctly. The production site build also passes and generates 253 static pages. Browser layout and live endpoint checks remain unverified in this workspace. Publication and deployment are outside this public change.

# Keep copied agent failures unambiguously textual

Status: implemented
Translation: current

[中文](2026-09-29-error-report-clipboard-text.zh.md)

## Abstract

Copied agent failures could arrive as percent-encoded `error:` URLs. The report
builder and clipboard helper already pass plain text, but the initial `Error:`
label is valid custom URL syntax. The builder now uses `Error details:` so a
consumer cannot parse the report as an absolute URL. This preserves diagnostic
fields and message content; the exact native conversion path remains unverified.

## Decision and evidence

This follows the [banner copy action](../simplification/2026-09-23-agent-notice-banner-full-width.md).
`new URL('Error: 启动失败')` succeeds with protocol `error:`, whereas the new
report fails URL parsing. Changing the shared report builder covers both banner
and legacy dialog callers without rewriting the general clipboard helper.
Decoding arbitrary clipboard content would corrupt legitimately encoded URLs
inside error messages and would not prevent downstream URL detection.

## Verification

The existing report suite now checks the new label and a synthetic Chinese,
multiline report containing a URL and a literal percent sign. Direct Node
assertions passed for these cases and title-only errors. Vitest could not run
because this checkout has no installed dependencies. Native clipboard round-trip
testing remains outstanding. Documentation checks ran but reported unrelated
repository documentation errors.

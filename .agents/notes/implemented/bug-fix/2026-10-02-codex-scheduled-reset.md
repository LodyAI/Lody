# Codex scheduled reset compatibility

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1209

[中文](2026-10-02-codex-scheduled-reset.zh.md)

## Abstract

The reset panel missed scheduled announcements because it only parsed `active_watch`.
The public status endpoint now returns `scheduled_reset` separately, including when
there is no active watch. Normalize and show that announcement in both entry points
and the dialog, without inventing a probability. Passing the scheduled time does not
prove execution; the announcement remains visible until the endpoint removes it.

## Evidence and decision

On 2026-10-02, the [public schema](https://codex-resets.com/api/openapi.json) and
[status endpoint](https://codex-resets.com/api/v1/status) returned a separate schedule
for `2026-10-02T17:00:00Z` while `active_watch` was null. This is October 3, 01:00 in
Asia/Shanghai. The schema permits a null scheduled time and an observed source with
no URL. The parser accepts these shapes, sanitizes source links, and keeps the watch
and latest executed reset separate. Reusing watch expiry/probability would misstate
an explicit announcement, so scheduled content takes precedence and labels the time
as planned rather than guaranteed. Existing fetch/cache/provider gating is unchanged.

## Validation

Synthetic parser and dialog cases cover absent schedules, nullable/invalid times,
source shapes, precedence, and the exact scheduled instant. Storybook includes future,
pending-execution, and unspecified-time states. Test execution is limited by missing
workspace dependencies; no live UI validation has been performed. Independent parser
checks passed against synthetic cases and the live response using locally available
Zod/TypeScript; changed TypeScript files passed syntax diagnostics and Oxfmt. These
checks do not replace the workspace typecheck or React tests. Documentation checking
reports existing links into uninitialized ACP submodules; none involve this change.

# Sidebar pull request aggregation

Status: implemented
Translation: current

[中文](2026-11-02-sidebar-pull-requests.zh.md)

## Abstract

A Session can contain multiple associated pull requests, but the sidebar previously projected only the latest one. The sidebar now offers a compact, neutral count for multiple associations and exposes each PR's own status and destination in a list. A single PR remains directly accessible. The existing metadata does not describe stack relationships or titles, so the list does not infer either.

## Decision and limits

The list uses the resolved Session associations and lifecycle states already available locally, without adding GitHub requests. Full URLs identify destinations, including PRs with the same number in different repositories. The [folded group status decision](2026-09-26-sidebar-folded-group-status.md) remains independent of the PR indicator.

A stack indicator requires explicit relationship data; treating array order as a stack would misrepresent independent PRs. With Show Branch enabled, the PR control aligns with the branch line at the lower right and remains visible alongside activity indicators on the title line; with it disabled, the sidebar row hides the PR control. The branch yields space to the PR control; line-change totals remain in the hover card. A single PR displays its status glyph before its number without a CI overlay or badge surface; multiple PRs show a neutral count. The number and count use the same neutral foreground as branch metadata, while the icon conveys PR status. Single-line rows retain the existing activity priority. PR titles likewise require a separate source and are not available from the Session association. Verification is limited to component behavior and the available local rendering environment; it does not establish live GitHub synchronization or usability with real accounts.

Two-line rows also show recorded nonzero added/deleted line totals after the PR. Local project metadata and Updated rows use the same recorded totals; missing statistics are omitted. Branch text yields space before the trailing details.

At narrow row widths, line totals yield to the branch and PR control; their full values remain in the hover card. The PR control is centered on the metadata line even though its hit target is taller than the text.

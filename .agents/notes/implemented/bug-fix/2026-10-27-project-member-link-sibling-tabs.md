# Keep non-Git member links for sibling tabs

Status: implemented
Translation: current

[中文](2026-10-27-project-member-link-sibling-tabs.zh.md)

## Abstract

A non-Git Project member reaches the agent either as an ACP additional directory or,
when the Provider lacks that capability, through a link in the main directory.
Child tabs share the main directory and the Project snapshot, and each re-decided the
mode at startup: a tab whose Provider takes additional directories removed the link,
so a running sibling whose Provider lacks them lost the folder mid-conversation, and
the snapshot flipped with whichever tab started last. A correct link is now kept;
Providers that take additional directories still receive the absolute path, and the
snapshot records `link` whenever the link exists.

## Decision and evidence

`resolveAdditionalDirectories` (session-manager) and Project preparation call
`reconcileProjectMemberLink`, which unlinked a correct link when `additional` was
true. It now keeps it and reports whether the member is reachable through a link;
callers record `link` or `additional` from that result. A link to another target is
still removed, and none is created for a Provider that takes additional directories.

Both paths name the same folder. File roots register the member once either way, the
main directory is not a Git checkout, and archive already removes only known links.
Passing the additional directory alongside the link also lets sandboxed Providers
allow writes to the real path. Considered: stop passing additional directories once a
link exists (one path for agents), rejected because sandboxes that resolve real paths
could then refuse writes.

## Validation

`workspace-git-service.test.ts` covers a parent link surviving a later
additional-directory start, removal of a wrong link, and no link creation; it fails
with the old unlink. Session-start, worktree and session-manager suites pass. CLI
typecheck reports only the unbuilt `acp-extension-claude` artifact. Not exercised
end to end with two real Providers.

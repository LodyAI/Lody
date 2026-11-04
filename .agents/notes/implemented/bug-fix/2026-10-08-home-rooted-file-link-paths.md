# Home-rooted paths in local file link actions

Status: implemented
Translation: current

[中文](2026-10-08-home-rooted-file-link-paths.zh.md)

## Abstract

An agent-written `~/...` path in chat could be previewed (the machine-side
preview policy already expands `~`), but the desktop Reveal/Open/editor actions
failed with `not_found`: the renderer joined the tilde path onto the workspace
root (`<workspace>/~/...`). `resolveLocalWorkspaceFilePath` now treats a
home-rooted path like an absolute one — it expands against the session
machine's home directory only for a same-machine local target, and stays
unresolved otherwise, so it is never joined onto the workspace. The `~user`
form keeps its existing workspace-relative meaning because other users' homes
cannot be resolved in the renderer. Remote sessions still get Copy Path only.

## Decision and evidence

The reported failure resolved `~/Code/my-spells/better-readme/SKILL.md` to
`<workspace>/~/Code/my-spells/better-readme/SKILL.md`. Two resolvers touched
the same string with different rules: the CLI preview policy
(`apps/cli/src/lib/file-preview/file-preview-path-policy.ts`) expands a leading
`~` against `os.homedir()`, while the renderer's
`resolveLocalWorkspaceFilePath` knew only absolute vs workspace-relative and
fell through to the workspace join. The fix keeps the split: the renderer
resolver gains a `homeDir` parameter (the Electron probe's `localHomeDirAtom`,
passed only when the session machine is local) and expands `~`, `~/...` and
`~\...` under the same `allowExternalPaths` gate as absolute paths. Without a
local target or a known home it returns null, so Copy Path falls back to the
verbatim text and no shell action is offered remotely.

The alternative of normalizing `~` inside `markdown-agent-file-link.ts` was
rejected: that module owns Markdown href parsing (line suffixes, URL decoding,
worktree roots), not host identity, and rewriting the stored path would also
corrupt Copy Path for remote sessions whose home the viewer does not know.
Expanding at identity-resolution time keeps the original text intact for
display and clipboard while only the path handed to the desktop bridge is
expanded. This extends the path forms covered by
[local file link actions](2026-09-09-local-file-link-actions.md); intent now
lives in the updated [draft spec](../../../../specs/local-file-link-actions.md).

## Validation

`session-local-file-path.test.ts` covers POSIX/Windows home expansion, bare
`~`, unknown-home and remote rejection, and the `~user` fall-through.
`use-session-file-actions.test.tsx` replays the reported Markdown-link scenario
(reveal receives `/home/dev/...`) and asserts a remote session resolves nothing
and copies the verbatim `~/...` text. Native Finder behavior still requires an
actual desktop runtime check.

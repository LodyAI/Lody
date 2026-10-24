# Git commit identity

Status: draft
Translation: current

[中文](git-commit-identity.zh.md)

A turn requested by the machine owner uses native Git identity and signing at the
command's working directory. Lody adds no author/committer or signing overrides
and performs no identity policy or cloud profile query. Repository configuration,
conditional includes, global/XDG files and explicit user environment retain Git's
normal precedence. Missing identity follows Git's native behavior, including
configuration errors; Lody does not silently substitute its neutral identity.
Repository configuration, including managed bare repositories, is preserved.

Other requesters use only their resolved Lody/GitHub identity, never a machine
identity fallback. Missing-email placeholders are unusable; unresolved members
use `LodyAI <agent@lody.ai>`. Lody exports this identity as author and committer
and disables automatic commit/tag signing with an empty signing key in new command
environments, including local projects. Explicit Git command options can override
signing defaults; this is not OS-level key isolation. GitHub authentication remains
a separate conversation-owner decision.

Non-owner cloud profile queries wait at most 60 seconds. Failure or timeout uses
a placeholder for this turn; later queries may retry. Late results cannot replace
a newer cached profile. Machine authorization and GitHub credential checks remain
independent of this fallback.

Changing requester or attribution must not restart ACP or its sandbox. New host
commands use the current turn's policy; returning to the machine owner removes
Lody's member overrides. Existing ACP children retain their launch environment,
so their direct Git commands may retain previous identity and signing settings.
Live propagation without restarting remains unimplemented.

## Evidence

Selection lives in `apps/cli/src/session/git-identity.ts`; `session.ts` applies
it to command environments. Creation and continued turns bind the frozen requester
in `session-manager.ts` and `session-execution-service.ts`.
See the [implementation note](../.agents/notes/implemented/bug-fix/2026-10-23-native-git-identity.md)
for behavior tests and limits. This Spec remains draft; deployed-client acceptance
is unverified.

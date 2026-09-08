# Temporary session validation bypass

Status: draft
Translation: current

[中文](session-validation-hotfix.zh.md)

A valid message must not be rejected by whole-state validation of unrelated old
history. As a temporary availability trade-off, renderer and CLI session Mirrors
skip update validation. Other document validators and external input parsers stay
unchanged. This does not guarantee malformed local writes are rejected, make old
items renderable, or authorize a history migration.

Acceptance here is a local CRDT update, not successful persistence, agent execution,
or remote delivery. Writer replacement remains a separately reviewed change (#460);
restore protection through changed-input validation without reintroducing an old
history gate. Unpatched clients retain the old behavior.

Evidence: `packages/shared/tests/session-validation-hotfix.test.ts` and
`mirror-construction-sites.test.ts`. No deployed-client acceptance is claimed.
Draft for human review; tests do not grant approval.

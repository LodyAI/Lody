# Agent maintenance entry

This tree holds maintenance workflows and important decision records. Keep each
rule in its owning document and link to it here instead of repeating it.

- [Document maintenance](README.md): task maintenance, scoped audits, and
  asynchronous translation. Read it when maintaining Specs or important notes.
- [SHA review](content-review.md): read when protected content changes.
- [Note rules](notes/AGENTS.md): when to write a note, its contents, classification,
  lifecycle, and historical retention.
- [Spec rules](../specs/AGENTS.md): public client/protocol intent and approval.
- [Documentation rules](docs/AGENTS.md): agent-maintained cross-module
  explanations; where oversized `AGENTS.md` content lands.
- [Where content goes](README.md#where-content-goes): read before moving content
  out of an oversized `AGENTS.md`.

Only public evidence belongs here. Exclude private conversations, sensitive data,
captured transcripts, and internal task records. Invariants remain in the nearest
existing `AGENTS.md`; notes explain decisions rather than duplicate those rules.

## Documentation at submission

For future tasks, write new or revised documentation around final behavior or the
current proposal, its decisions, trade-offs, evidence, and verification limits.
Before submission or delivery, consolidate the passages written for that task into
one coherent account. Integrate corrections into their owning sections.

Retain development history only when it explains an important constraint or
trade-off, prevents a known mistake, or qualifies the evidence. Omit superseded
iterations, resolved temporary errors, and repeated test or environment logs that
serve none of those purposes.

Limit consolidation to content introduced or changed by that task. This does not
require retrospective cleanup of existing documents; preserve earlier recorded
decisions. Proposals and unverified outcomes retain their status.

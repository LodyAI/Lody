# ACP capability cache compatibility

Status: draft
Translation: pending

During mixed-version operation, a client must retain ACP capability fields it can parse even
when the producer's `cacheVersion` differs. The version marks an entry for refresh; it does not
invalidate otherwise understood models, modes, configuration options, commands, or lifecycle
capabilities.

A client may refresh an older entry in the background and replace it after a successful probe.
Until then, the parsed entry remains usable. When an older version contains a field with known
incompatible semantics, the reader adapts or omits that field while preserving the rest of the
entry; a version bump must not invalidate the entire entry. Runtime overrides remain
source-specific: capability data collected for a different override must not be applied merely
because its structure is readable. Data that fails the wire or storage schema is outside this
guarantee and may be rejected at the parsing boundary.

Evidence: `packages/shared/tests/ai-capability-cache.test.ts`,
`packages/components/tests/acp-selector-options.test.ts`, and
`packages/components/tests/provider-status.test.ts`. Draft for human review; tests do not grant
approval.

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

Registry Cursor model IDs are a known protocol incompatibility: a Machine advertising the
parameterized picker cannot use a row produced before that opt-in. Readers require the picker
source marker on that Machine and refresh an incompatible row; a legacy Machine keeps using its
unmarked variant IDs. A marked row remains readable across cache versions.

Role availability additionally requires evidence from the bound daemon's current source.
A daemon advertising `acpCapabilitySources` publishes an independent expected-source snapshot;
its epoch must match Machine metadata, and the Role's observed `sourceVersion` must match the
snapshot for that config. Missing discovery, a previous daemon epoch, or a runtime revision
mismatch leaves capability-dependent availability unknown until matching evidence arrives.
A late result from an old runtime cannot redefine the expected source. Daemons without this
protocol retain existing readable-cache behavior, including mixed cache versions; clients
must not infer a remote source from their own bundled versions.

Evidence: `packages/shared/tests/ai-capability-cache.test.ts`,
`packages/components/tests/acp-selector-options.test.ts`, and
`packages/components/tests/provider-status.test.ts`. Draft for human review; tests do not grant
approval.

# Bind encrypted Schedule execution to its original signer

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/2012, https://github.com/LodyAI/Lody/pull/2018

[中文](2026-10-28-e2ee-schedule-origin-authorization.zh.md)

## Abstract

A writable Schedule owner field is not execution authority. A foreign member could forge that field and the Registry fingerprint, then let the target machine turn the hostile prompt into a machine-signed user turn. Encrypted Schedule writes now append a CRDT declaration that binds the execution fingerprint to its signed original update. Both Schedule handoff and the shared actual-start claim authorize that declaration's verified device through the existing machine access check. The ledger and ordinary-workspace behavior are unchanged.

## Decision

Only protected authoring appends a map to the `scheduleAuthorizations` Loro list. A definition declaration carries `kind: definition` and `definitionFingerprint`; a manual declaration also carries its stable `manualRunKey` with `kind: manual`. No identity field grants authority. The list insertion operation identifies the original signed update to reopen, verify and reconstruct from its exact bytes and dependencies. The reconstructed declaration and execution fingerprint must match the current document. Any later operation in the definition, prompt or message subtree invalidates it, including deletes and same-value rewrites. A deliberate save creates a new declaration; timeline activity alone does not invalidate it.

The host retains encrypted Schedule update originals using the same receipt store and bounded recovery as session originals. Every invocation checks the current verified signer against the existing authenticated machine access policy and checks for document changes across that wait. Manual requests require both the definition and request signers. Registry rows remain discovery/publication gates, not grants.

In the A3 composition, definition and manual signers use the same machine/project sharing gate as ordinary execution. Handoff checks the signed definition's local project; actual start supplies the resolved Session target, including explicit chat-only absence. Source authorization checks remain live through the synchronous journal claim, intersected with the generated turn's own check. A later signer's authenticated refresh can invalidate an earlier ledger snapshot even without a permission change: retry source checks once through the now-populated requester caches, then recheck the turn signer. An unstable or withdrawn result still refuses the claim. This preserves availability for valid multi-device schedules without dropping any actor's authority.

Generated encrypted turns freeze the fingerprint and optional manual run key in `scheduleRun`, covered by their original update verification. The actual-start journal claim requires the independent Schedule authorization again, so cached preparations, a committed pointer or the machine's signature cannot replace the originating grant. Missing declarations/originals fail closed and remain retryable; a cold snapshot-only replica may require an owner save when old originals have been trimmed. Snapshot authors cannot endorse historical Schedule input.

## Evidence and limits

The adversarial fixture in `apps/cli/tests/e2ee-runtime.test.ts` uses a real foreign ledger member, signed encrypted Schedule/Registry content and SQLite planning. It verifies rejection before preparation, plus actual-start rejection without source authority or after tampering. Related cases cover target/rule/prompt edits, same-value rewrites, snapshot-only evidence, manual requests and changes during authorization. These fixtures do not establish deployed or packaged multi-device acceptance.

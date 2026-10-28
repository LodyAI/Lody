# Encrypted workspace sharing publishes an explicit plaintext copy

Status: implemented
Translation: current

[中文](2026-10-28-e2ee-share-plaintext-consent.zh.md)

## Abstract

Static sharing copies readable conversation content outside workspace membership. The owner chose to allow this for encrypted workspaces after an explicit warning and confirmation, prioritizing the existing sharing workflow. The copy is server-readable; revocation cannot recall content already viewed or copied. Ordinary workspaces retain their existing flow, and no reader-side decryption key or new sharing format is introduced.

## Decision

The encrypted editor asks for confirmation before capture, deployment admission, object upload or publication. The disclosure states that a decrypted copy leaves E2EE, the server can read it, and revocation cannot recall previously viewed or copied content. Dialog, inline editor, Settings updates and MCP approval all use the same publication hook. Cancel returns to the editor or approval card without publication; MCP cancellation of this warning does not deny the request. Each publication action, including retries and updates, asks again. Consent freezes the runtime, workspace/root, selected session ID set, sharing record/version and MCP request identity in memory. Capture uses only those frozen IDs. A changed scope, record, candidate set that no longer permits the selection, or missing source invalidates confirmation and requires a new human action. Rechecks run after asynchronous capture and immediately before deployment admission, object upload and publication. The only accepted record transition is this attempt's exact acknowledged admission. Updates accept the existing or prepared source mapping; new shares accept an empty draft or the prepared mapping, including when replacing a revoked share. An unrelated record, revision or source mapping cannot be mistaken for that transition. Derived `canManage`/`canRevoke` flags do not identify the publication scope; the server authorizes each mutation independently. Ordinary-workspace publication retains its existing flow. Consent is neither a persisted preference nor an agent authorization.

After confirmation, the client reads through the same workspace source adapter and prepares, uploads and commits the same static package as an ordinary workspace. The existing URL fragment bearer remains an access credential, not a content-decryption key. The rejected alternative was a fragment decryption-key design: the owner explicitly chose the existing server-readable publication boundary instead. No ledger, key-custody or anonymous-reader protocol changes are required.

This resolves the deferred sharing decision in [file and preview availability](2026-10-28-e2ee-file-preview-availability.md) and partially supersedes the public-link restriction in [M2 integration](../../proposed/architecture/2026-10-22-e2ee-m2-product-integration.md). Those notes retain their other decisions.

## Evidence and limits

The [publication-hook tests](../../../../packages/components/tests/use-session-share-management.test.tsx) render the production manager with English and Chinese copy, check zero capture/mutation/upload before confirmation and after cancellation, and decode actual HTTP object-upload bytes after confirmation. The server-selection drift regression uses the real capture and upload code; record/source changes during confirmation or asynchronous publication stop before the next publication boundary, and a fresh confirmation is required. Revoked-share replacement coverage accepts the exact fresh admission while rejecting foreign record IDs, versions and source mappings. The [source-adapter suite](../../../../packages/components/tests/session-share-publisher.test.ts) exercises both workspace modes with the real compressed package path. [MCP-card tests](../../../../packages/components/tests/session-share-request-cards.test.tsx) exercise its approval and cancellation wiring. These synthetic tests establish client ordering and payload behavior, not live hosted-backend or installed-device acceptance.

Implementation: [PR #2022](https://github.com/LodyAI/Lody/pull/2022).

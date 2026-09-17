# Return approved share links to the requesting agent

Status: implemented
Translation: current

[中文](2026-09-16-mcp-share-link-delivery.zh.md)

## Abstract

MCP sharing previously ended at a pending request, leaving the user to publish and
copy the result. One explicit consent card now starts the existing publication
pipeline and returns the full bearer URL to the agent. A recipient-encrypted
mailbox supports approval from another device without putting plaintext credentials
in the control plane. Each request creates an independent share so it neither
requires another device's old secret nor changes what existing readers can access.

## Ownership and trade-offs

The app owns approval, capture and publication; the CLI owns a durable, request-scoped
RSA-OAEP recipient key and local decryption. The cloud stores public keys and encrypted
reader secrets, binds them to deployment admission, and authorizes retrieval only
after publication. OAEP's label binds request record and origin. This is credential
delivery, not encrypted share content. Existing sharing authorization remains the
publication boundary; possession of a recipient private key cannot approve a request.

A local-only callback would fail for Web or remote machines and lose pending results
on restart. Storing plaintext URLs would violate the existing credential boundary.
An encrypted mailbox reuses the canonical request record and atomic begin operation,
without introducing a second daemon control protocol or renderer-to-daemon authority.
It adds local private-key storage and requires coordinated host/client deployment.
Legacy intents without the new consent fields expire rather than gain new authority.

Review correction: workspace membership alone did not prove that the daemon account
was acting for the claimed human. Undisclosed cross-account requests could deliver a
victim-approved credential to a different submitter. Delivery now requires the CLI
account, active requester and real approver to be the same user, enforced at admission
and every existing-request publication/delivery path. CLI mismatch fails before key
creation; it never substitutes the machine owner. Same-account remote approval remains
available, but cross-account shared-machine MCP sharing is deliberately unsupported.
Displaying a recipient's name alone was rejected in favor of this fail-closed boundary;
delegation needs a separately verified consent contract. This is account binding, not
cryptographic attestation of Session/Turn provenance, and cannot recall old disclosures.

Calls wait briefly, then resume with the same request ID, purpose and targets;
the user approves once. The key survives MCP restarts. The result is unavailable
after the 24-hour delivery window, reset, revoke or membership replacement.
Interrupted uploads retain the existing abandon/retry rules; no resumable upload
credential is added. Canonical capability fragments are omitted from future exports,
including opaque tool output, while the agent and live conversation retain full URLs.

This extends the [static-publication decision](../../proposed/architecture/2026-09-12-static-session-sharing.md)
and updates the [sharing Spec](../../../../specs/session-sharing.md), still draft.

## Verification

Behavioral tests cover recipient/request/origin binding, history projection, one-click
publication, retry credentials, server membership/result gates, independent shares and
approval across the expiry boundary. No hosted deployment or real-user conversation
publication is part of this change. Public and hosting changes require coordinated PRs.
Regression tests reject a different workspace writer's direct API request and fence
legacy pending, confirmed, sealed and published requests, including replay paths.

Implementation: [PR #762](https://github.com/LodyAI/Lody/pull/762).
Integration retains the non-virtualized card boundary; explicit upload signals verify
that scrolling and confirmation updates cannot interrupt automatic publication.

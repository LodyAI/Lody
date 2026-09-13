# Read original conversations through explicit share links

Status: implemented
Translation: current

[中文](2026-09-09-session-sharing.zh.md)

## Abstract

A live conversation link must provide continuing access without granting the
recipient workspace membership or write authority. The client now combines an
explicit target picker with an isolated, in-memory reader of each original Loro
stream. Link secrets belong to the creating device and travel to the sharing
API as bearer credentials. Reading the original stream preserves history and
live updates, but also exposes stored content beyond the current presentation;
the sharing disclosure states that trade-off. Hosted authorization and native
device acceptance remain separate verification responsibilities.

## Decision and boundaries

The [draft specification](../../../../specs/session-sharing.md) owns intended
behavior; [the sharing module rules](../../../../packages/components/src/components/sharing/AGENTS.md)
own implementation invariants. This complements
[local image export](2026-09-08-chat-share-image.md), which captures a selected
snapshot rather than authorizing continuing stream access.

Original-stream reuse avoids maintaining a second transcript projection and
preserves existing snapshot and update compatibility. It deliberately forgoes
field redaction and per-message publication. Related Tabs are discovery hints;
only explicit selection and the authorized manifest determine what a reader
may open. Independent child links retain separate authority.

```text
Cloud-capable client
  management dialog -> public cloud DTOs -> sharing service
  successful create/reset -> device secret -> explicit-host link

Anonymous reader
  link fragment -> bearer API -> authorized manifest
  selected target -> one in-memory LoroDoc -> shared message renderer
  attachment reference -> bearer API -> transient object URL
```

The host supplies the share origin. Public packages contain no hosted deployment
default, backend implementation, or generated backend API. Local composition
hides management through the existing capability boundary. The reader does not
mount the authenticated application, and its stream adapter disables uploads
independently of a method/path gate that allows only reads.

Device secrets are credentials rather than replaceable cache. Expected versions
and identity checks prevent a delayed management result from saving a secret to
another account or accepting an obsolete edit. Failure to persist a successful
secret leaves a temporary copy action and explains the need to reset later.

## Reconnection discovery

The stream SDK retries live reads, but a failed initial join removes its status
listener. Simply retrying on that same transport can leave the page permanently
paused or lose subsequent status updates. The reader retains the original
LoroDoc and recreates only the closed transport for retryable initial failures,
using bounded backoff. Disposal and access denial cancel pending retries;
non-retryable failures do not start a retry loop.

## Evidence and remaining limits

Synthetic [reader tests](../../../../packages/components/tests/session-share-reader.test.ts)
cover read-only transport, snapshots, incremental updates, invalidation, and
initial-join recovery. [Management tests](../../../../packages/components/tests/use-session-share-management.test.tsx)
cover credential persistence, identity changes, version conflicts, and explicit
origin injection. Candidate, secret-storage, manager, and mobile-menu tests cover
their public client boundaries; controlled Storybook surfaces use synthetic data.

Local typechecks, tests, and isolated browser integration were exercised during
implementation; the PR gate must validate the final integrated revision.
Public tests cannot establish hosted token enforcement, service replication,
attachment lifecycle configuration, or native-device keyboard behavior. The
draft spec remains unapproved and its translation pending. Implementation review: [PR #539](https://github.com/LodyAI/Lody/pull/539).

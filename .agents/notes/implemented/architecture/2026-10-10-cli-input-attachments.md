# Separate attachment preparation from turn submission

Status: implemented
Translation: current

[中文](2026-10-10-cli-input-attachments.zh.md)

## Abstract

CLI create/chat authored text-only turns even though the runtime already supported
attachment inputs. Input preparation now freezes caller-owned files, reuses one
byte-transfer service with agent output, and returns references to the existing
message writers. MCP Operations preserve those references atomically for recovery,
without rereading mutable source files. Deterministic local tests cover these
boundaries. Staging acceptance also verified create/chat from one Mac to another:
remote tools read the complete 39,052-byte fixtures and returned matching random
suffixes and SHA-256 hashes; a mixed file/image continuation correctly recognized
the image. Live MCP recovery remains unverified.

## Responsibilities

```text
CLI paths / MCP workspace-scoped paths
  -> input preparation: validate + private snapshot
  -> transport: relay or local blob store
  -> complete input references
  -> command writer: history + frozen execution input + activation
  -> existing daemon: materialize files + invoke agent

MCP acceptance -> Operation input side table -> same command writer on recovery
```

The existing assistant upload tools continue appending assistant output. Reusing
their history mutation would misattribute user attachments, so only byte transfer
is extracted from MessageHandler. Putting source paths in target commands would
read the wrong machine; reopening them during recovery would read different bytes.

`operation_inputs` keeps generated references outside the canonical command's
retry fingerprint and outside strict legacy Operation rows. Acceptance and the
side-table insert share one transaction. Capability negotiation prevents new MCP
callers from handing recovery to an old daemon that silently ignores attachments.
Concurrent losers may leave relay objects to existing retention cleanup.

Real history-reader tests exposed normalization of empty prompts and omitted
undefined fields. Retry comparisons therefore use the shared input-config
normalizer and serialized content, while checking every attachment.

This extends [deferred attachment preparation](2026-09-14-deferred-attachment-send.md)
and preserves [frozen execution input](2026-10-08-frozen-turn-execution-input.md).
Behavior and limits: [Spec](../../../../specs/cli-session-attachments.md).

## Live verification limits

Attachment-only creation also returned the expected fixture token, and a later
independent observation reported the turn completed. Its CLI `--wait` exceeded
180 seconds, however. Staging also produced workspace-routing and Streams
confirmation timeouts during this run. This verifies content delivery, but does
not establish reliable completion receipts under those conditions. Live durable
MCP recovery and large multipart inputs were not exercised.

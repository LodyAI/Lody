# Keep a client log and send it with machine bug reports

Status: implemented
Translation: current

[中文](2026-10-16-client-bug-report-log.zh.md)

## Abstract

Bug reports carried the machine daemon's logs but nothing from the app the user
was looking at, and the renderer's own diagnostics lived in memory, so they
were gone by the time an iOS user, whose WebView had just been killed and
reloaded, opened the report dialog. The renderer now keeps a log of important
events in IndexedDB, bounded to the newest 2 MiB within 48 hours. It covers
crashes caught by error boundaries, boot failures, failures nothing retries,
stuck boot waits, reloads, and a previous page that ended without unloading.
A machine-backed bug report sends it gzipped to the daemon, which uploads it as
a `client.log` section of the same `logContent`, so one report holds both
logs. A description-only report still sends no logs, because the hosted
endpoint's contract for that path is not visible in this repository.

## Problem

`machine/bug-report` asked the selected machine to upload its own logs.
The renderer contributed only build constants. What it did know lived in
memory (the session render trace, boot request failures), so it disappeared
with the event that mattered most: a WebView the OS killed and reloaded, or a
renderer crash that the user then reloaded away.

## Decision

**Recording (`lib/client-log.ts`).** An explicit API, `recordClientLog` and
`recordClientError`, rather than intercepting `console`, so only events a
caller chose are kept. Every string passes through `redactClientLogText`. It
strips bearer and basic credentials, JWTs, and query parameters, JSON fields and
headers whose name contains a credential word anywhere (`refresh_token`,
`client_secret`, `api_key`, `X-Amz-Signature`). The patterns run on error paths,
so names are captured with a length limit and tested in a callback; an earlier
backtracking pattern took seconds per entry on long text. One entry, stack
included, is capped at 16 KiB.

| Event                                         | Source                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `react.error_boundary`                        | every `ErrorBoundary` catch, with boundary name and component stack           |
| `boot.failed`, `boot.failure_reload_clicked`  | the pre-React boot failure page                                               |
| `runtime.operation_failed`                    | `RuntimeProvider` failures outside shutdown                                   |
| `boot.wait_stuck`                             | a `BlockingWaitPlaceholder` reaching its recovery page, with gate and blocker |
| `cache.clear_on_boot`, `app.reload_requested` | clears run at boot, and reloads the app asks for                              |
| `window.error`, `window.unhandled_rejection`  | uncaught errors                                                               |
| `page.boot`, `page.visibility`, `page.hide`   | the lifecycle around them, with navigation type and build                     |
| `page.previous_ended_without_unload`          | a previous page that never reached `pagehide`                                 |

The last row is how an automatic restart shows up. Nothing runs when a WebContent
process is killed, so each page load keeps its own entry in a `localStorage`
marker map, keyed by boot id. The entry is updated synchronously on visibility
changes and `pagehide`. Every page also holds a Web Lock named after its boot id
for as long as it runs. A new page reports each entry that never ended and
whose lock nobody holds, with its last visibility and when that changed, then
removes the entry. So a window or tab that is still open is never reported, and
one page's ordinary exit cannot hide another page's kill. Without the Locks API
the report says `liveness: unknown`. The pre-React failure page installs the log
too (installation is idempotent), so its entries carry a boot.

**Storage.** Entries are written in batches (an error is written at once, and
the page flushes when hidden), to the `lody-client-log` database.

- **Pruning:** the store is pruned whenever 256 KiB have been written since the
  last prune, so a burst of errors cannot grow it far past its budget.
- **Unavailable storage:** an open that errors or has not settled within 3 seconds
  counts as unavailable for that attempt. WebKit can leave an open pending
  forever after its storage process restarts. The open is retried after 30
  seconds, and a late success is closed rather than leaked, so it cannot block a
  full reset's delete. Meanwhile entries stay in memory under the same limits.
- **Reloads:** a reload or a kill does not wait for an IndexedDB transaction.
  When the page hides or unloads, entries not yet committed are therefore saved
  synchronously to `localStorage` (at most 128 KiB). The next page imports them,
  and every read de-duplicates by entry key and orders by time. That keeps the
  `app.reload_requested` entry a reload would otherwise drop.
- **Clearing:** a cache clear keeps the log, because it explains why the clear
  was needed; a full reset deletes it.

**Sending.** The bug report dialog builds the upload: the newest lines that fit
2 MiB raw and 1 MiB gzipped, base64 encoded. It waits at most 5 seconds for
storage, then files the report without the log rather than never. The 1 MiB compressed bound matches
the Code Collab and file-preview payloads that already cross the Loro Streams
request path. The `machine/bug-report` request schema is strict, so an older
daemon would reject the whole report if the field were present. The client log
is therefore gated on the new `bugReportClientLog` machine protocol capability.
The workspace RPC facade drops the field for a machine that does not advertise
it, and the report is still filed. The daemon decodes the log and appends it
after its own logs. If the log does not decode, the section says why instead of
failing the report. The schema bounds the base64 string itself, so an oversized
payload is rejected before the daemon decodes anything. The contract and limits
live in the schema-free `@lody/shared/bug-report-client-log`, so the pre-React
boot and recovery pages do not pull a schema library in.

## Alternatives

- **Capture all `console` output.** It would keep agent text, paths and URLs that
  callers never chose to keep.
- **Upload the client log directly from the renderer under the same report id.**
  It would need a new hosted endpoint and would split one report into two uploads.
- **Put the log in the description.** Descriptions are user-authored text and
  are shown as written, and their size limits are not known here.

## Limits

- **Description-only reports:** a report filed without an online machine still
  carries no client log. Sending `logContent` on that path needs the hosted
  endpoint to accept it.
- **Plaintext in the request stream:** the client log rides in the request
  parameters in plaintext, as the description already does, so it is retained in
  the workspace request stream until expiry. Encrypting it to the target machine,
  as authentication input is, would remove that.
- **Kill while visible:** a kill gives no warning. Entries recorded after the
  page last hid, and not yet written, can be lost; the boot marker survives
  because it is synchronous.

## Verification

- `tests/client-log.test.tsx` covers:
  - persistence across a simulated reload;
  - detection of a page that ended without `pagehide`;
  - a page still running in another window not being reported, then being
    reported once it dies;
  - entries saved on page hide surviving the reload that drops their write;
  - a report that does not wait on an IndexedDB open that never answers;
  - time ordering across memory and IndexedDB;
  - uncaught errors and rejections;
  - the age and byte limits;
  - redaction of credential names wherever the word sits;
  - an upload that decodes back to the log;
  - an `ErrorBoundary` catch recorded with its component stack.
- `tests/workspace-machine-rpc-facade.test.ts` checks that the log reaches a
  daemon that advertises it, and that a report to an older daemon is still filed
  without it. The check fails when the gate is removed.
- `packages/loro-streams-rpc` server test: the field reaches the daemon handler.
- `apps/cli` `bug-report.test.ts`: the uploaded `logContent` contains the
  `client.log` section, and an undecodable log is reported in place.

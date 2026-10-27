# Machine replacement credential isolation

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1949

[中文](2026-10-27-e2ee-replacement-credentials.zh.md)

## Abstract

Losing only a machine device original left its credential behind, preventing every replacement because the filename selected an old key's authenticated blob. Credentials now use genesis and signing public key in their filename. Fresh explicit sessions can prepare an independent replacement while keeping old evidence, but a published session cannot recreate its missing identity and an unpublished credential still prevents unsafe generation takeover. This changes only current local file lookup; it does not migrate developer data or change crypto, ledger or SQLite formats.

## Decision and ownership

Core custody owns key-scoped credential publication and authenticated readback. The CLI journal owns preparation generations, immutable context and the current identity pointer under its existing SQLite mutex. A missing original in a published session remains a conflict. A fresh session may replace a published identity after device ENOENT; its new key selects its own credential. When taking over an unfinished generation with no device, any keyed credential not accounted for by published material is retained evidence of that unfinished identity and blocks replacement. This preserves interrupted creation's fail-closed behavior without adding a journal field. Other file errors remain failures.

The alternative of removing or reusing the old credential destroys evidence or violates its authenticated key binding. Genesis-only lookup cannot represent two keys, so the filename includes the already authenticated public key. Former unkeyed developer files remain untouched and are not read or migrated. Existing developer identities using those files require explicit new pairing/recreation, preserving their old custody. Reopening missing credentials still fails; it never silently issues a new access secret.

Preparation owns local native work until its existing Scope settles; cancellation and takeover do not delete originals. Activation still requires explicit frontend approval, verified admission and current-key installation. Runtime journals remain signing-key-scoped, so a replacement never opens the old identity's protected epoch blobs. The custody wrapping KEK itself remains intact when only the device file is lost. No new lifecycle owner or Effect migration is needed: the changed journal is already native and the core operation remains one tracked native boundary.

## Evidence and limits

Regression suites cover staged and activated device-only loss through fresh admission, mailbox installation and activation; unchanged old credentials and journal rows; independent credential hashes/runtime stores; same-session refusal; unpublished-generation refusal; exact retries; and authenticated rejection of a swapped credential blob. A current-only test preserves the unkeyed developer blob and rejects reading it. New regression failures are checked with the implementation withdrawn. Tests use synthetic custody and real crypto/files/SQLite with explicit signals and no network or sleeps.

Real OS keychains, physical desktop approval, packaged apps, cross-platform ACLs and production/cloud acceptance remain unverified. Full repository validation belongs to CI. This change is based only on main and does not consume the unmerged PR #1940.

Related decision: [machine pairing journal](../../proposed/architecture/2026-10-26-e2ee-machine-pairing-journal.md).

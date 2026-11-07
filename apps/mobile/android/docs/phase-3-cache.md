# Phase 3 first slice — connection recovery and catalog cache

User approved implementing the proposed connection follow-up and catalog cache with architecture first. Keep one module, manual construction and the existing runtime contract. Product page design and message-history navigation follow this foundation slice.

Native account state restores a credential-free account/workspace context before network validation. Cached context never authorizes a grant. Missing credentials, sign-out, authorization revocation and login switching clear the owned context and catalog cache. Transient authentication network failures preserve cached display with an explicit unverified flag.

CatalogRepository owns the selected workspace and display projection, subscribes once to RuntimeOwner, and persists only successfully synchronized snapshots. Cache hits are not LIVE. Scope switches cancel prior reads/writes and reject stale events. Restored server revisions may restart at zero and replace older cached revision numbers. Persist the chosen workspace, restore it after process death, and retry online synchronization after authentication succeeds. Cache failure must not stop cloud reads.

CatalogStore is a narrow suspend port. This slice uses atomic files in noBackupFilesDir, bounded UTF-8 payloads, opaque hashed scope filenames and serialized IO. It stores whole display snapshots, not credentials, CRDT state, cursors or send intents. Room was a roadmap suggestion; defer its compiler/dependency cost until relational message queries exist.

Connection follow-up: preserve grant receipt deadlines, classify native network errors correctly, add bounded non-sensitive connection timings for diagnosis, and verify retry/renewal and actual network recovery. Do not claim natural expiry or improved latency without evidence. Never modify the unchanged shared runtime snapshot.

Verification: JVM account/cache scope races, actual Android atomic-file restart/corruption/isolation tests, full JS/JVM/WebView regressions, builds/lint, actual authorized offline process restart and recovery. One fresh final review. Keep all existing files uncommitted in this unborn bootstrap repository.

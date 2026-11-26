# apps/cli-rs

Rust CLI (`lody`), execution daemon (`lodyd`), and black-box business conformance harness defined by [`specs/rust-cli-daemon-architecture.md`](../../specs/rust-cli-daemon-architecture.md).

## Workspace layout

- `bins/lody` — Composition root and single executable (`lody`). Default build wires the pure local composition without linking `lody-backend`; `--features connected` links vendor-neutral backend implementations.
- `crates/env` (`lody-env`) — Single source of truth for all environment variable names (`keys`), proxy and loopback `NO_PROXY` forwarding, `ELECTRON_RUN_AS_NODE` filtering, and typed process environment loaders (`HostEnv`, `ConformanceEnv`), enforced workspace-wide via `clippy.toml`.
- `crates/ports` (`lody-ports`) — Pure port traits and shared domain identifiers (`MachineIdentityPort`, `EnginePort`, `ScheduleRepoPort`, `HistoryPort`, `InboxStorePort`, `ScheduleLedgerPort`, `AcpLauncherPort`, `WorktreePort`, `BackendPort`, `VerifiedPrincipal` including `AgentSession`).
- `crates/kernel` (`lody-kernel`) — Pure deterministic session, turn, bounded 30s late-stream presence lease, native `sessionActivity`, and unified-inbox state machines; zero I/O, zero clock, zero async runtime.
- `crates/app` (`lody-app`) — Single application command/query interface and caller authorization (`enforce_command_policy` / `enforce_query_policy`) shared across CLI, MCP, local IPC, and remote RPC.
- `crates/runtime` (`lody-runtime`) — Actor supervision, resource leases, invoking-session owner verification for Schedule operations, worktree `base_branch` preservation, and execution of `lody-kernel` actions against `lody-ports`.
- `crates/entry` (`lody-entry`) — Pure protocol projections over `lody-app`: CLI commands (including `lody machine restore-id`), `mcp-stdio`, local IPC (`probe`, `control` with `localProjectId`-resolved `git-state`, project file search & branch pagination, and `terminal.sock` NDJSON PTY server), in-process Streamable HTTP MCP server (`/mcp` projecting `VerifiedPrincipal::AgentSession` for `lody_schedule` and `lody_catalog`), and remote RPC.
- `crates/sqlite` (`lody-sqlite`) — Cross-process `FileStorageLease` (`fd-lock` + yield handoff), 5-tier `LocalMachineIdentityStore` (`credentials.json` v3, `machine-id`, host-fingerprint anchor, deterministic HMAC-SHA256, and offline `restore-id` backups), and single-owner Node-schema-compatible SQLite stores (`operations.sqlite3`, `schedules.sqlite` execution ledger `schedule_cursors` + `schedule_runs`, `pr-poller-state.sqlite3`, `automations/<workspace>.sqlite`).
- `crates/acp` (`lody-acp`) — `ACP over stdio` client (including `_lody/session/activity_update` v1 session-scoped `requires_action` / `backgroundTaskCount` handling and isolated `_lody/session/archive` negotiation), process-group containment, `portable-pty` session terminal manager, and proxy-aware SHA-256 verified managed runtime artifact installer (`reqwest` + offline bundle).
- `crates/worktree` (`lody-worktree`) — Git worktrees with preserved `base_branch`, lightweight git summary & paginated branch queries, host-side file path search ranking, `LTD1` v2 FastCDC + `gzip`/`zstd` content-addressed `TurnDiffStore` (`WorktreeBranch` with `git_diff_base_ref_candidates` vs `UncommittedOnly` scopes), and `.gitignore`-aware parallel file tree scanning (`ignore`).
- `crates/engine` (`lody-engine`) — Clean `Unavailable` port stubs (`RepoEngineClient`, `FlockProjectStore`, `EngineScheduleRepo`, `RoostHistoryStore`) awaiting the standalone `loro-repo-engine` process, Flock catalogs/registry, and Roost history storage.
- `crates/backend` (`lody-backend`) — Connected and self-hosted implementations (`BackendProfile` auto-discovery, OIDC/CA, negotiated upload, artifact registry, SCM/tunnel, E2EE ledger/custody, Iroh).
- `crates/scripted-acp` (`lody-scripted-acp`) — Pure-Rust deterministic `ACP over stdio` agent double with explicit file barriers.
- `crates/conformance` (`lody-conformance`) — Black-box business behavior harness for single-target runs, A/B baseline-vs-candidate comparison, and shared-directory handoff (`Node -> Rust -> Node`).

## Build and verification

Build and test both default (`local`) and `connected` compositions:

```sh
cargo test --manifest-path apps/cli-rs/Cargo.toml --workspace
cargo test --manifest-path apps/cli-rs/Cargo.toml --workspace --all-features
```

Verify that the default local binary does not link `lody-backend`:

```sh
cargo tree --manifest-path apps/cli-rs/Cargo.toml -p lody
cargo tree --manifest-path apps/cli-rs/Cargo.toml -p lody --features connected
```

## Running conformance checks

Run the business conformance suite against a single CLI target:

```sh
LODY_CONFORMANCE_BIN="node apps/cli/dist/index.js" \
  cargo test --manifest-path apps/cli-rs/Cargo.toml -p lody-conformance
```

Run A/B differential comparison plus shared-data-directory handoff (`baseline -> candidate -> baseline`):

```sh
LODY_CONFORMANCE_BASELINE_BIN="node apps/cli/dist/index.js" \
LODY_CONFORMANCE_CANDIDATE_BIN="apps/cli-rs/target/debug/lody" \
  cargo test --manifest-path apps/cli-rs/Cargo.toml -p lody-conformance
```

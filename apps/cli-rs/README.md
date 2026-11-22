# apps/cli-rs

Rust CLI (`lody`), execution daemon (`lodyd`), and black-box business conformance harness defined by [`specs/rust-cli-daemon-architecture.md`](../../specs/rust-cli-daemon-architecture.md).

## Workspace layout

- `bins/lody` — Composition root and single executable (`lody`). Default build wires the pure local composition without linking `lody-backend`; `--features connected` links vendor-neutral backend implementations.
- `crates/ports` (`lody-ports`) — Pure port traits and shared domain identifiers (`EnginePort`, `HistoryPort`, `InboxStorePort`, `AcpLauncherPort`, `WorktreePort`, `BackendPort`, `VerifiedPrincipal`).
- `crates/kernel` (`lody-kernel`) — Pure deterministic session, turn, and unified-inbox state machines; zero I/O, zero clock, zero async runtime.
- `crates/app` (`lody-app`) — Single application command/query interface and caller authorization shared across CLI, MCP, local IPC, and remote RPC.
- `crates/runtime` (`lody-runtime`) — Actor supervision, resource leases, and execution of `lody-kernel` actions against `lody-ports`.
- `crates/entry` (`lody-entry`) — Protocol projections: CLI commands, `mcp-stdio`, local IPC (`lody-mux.sock` and `legacy_ipc_compat`), and remote RPC/MCP HTTP.
- `crates/sqlite` (`lody-sqlite`) — Single-owner SQLite pools preserving existing filenames (`operations.sqlite3`, `schedules.sqlite`, `pr-poller-state.sqlite3`, `automations/<workspace>.sqlite`).
- `crates/acp` (`lody-acp`) — `ACP over stdio` client, process-group / JobObject containment, and external managed adapter launcher.
- `crates/worktree` (`lody-worktree`) — Git worktrees, branch observation, credential broker, FastCDC turn snapshots, and parallel file scanning.
- `crates/engine` (`lody-engine`) — Client adapter for the standalone `loro-repo-engine` process plus coexisting Roost history storage.
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

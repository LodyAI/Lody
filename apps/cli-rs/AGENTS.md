# Rust CLI and daemon guidelines

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Root `AGENTS.md` and [`specs/rust-cli-daemon-architecture.md`](../../specs/rust-cli-daemon-architecture.md) apply.

## Scope and crate boundaries

- Keep `apps/cli-rs` outside `pnpm-workspace.yaml` until release synchronization is explicitly enabled for the Rust executable.
- `crates/kernel` must remain a pure deterministic state machine with zero I/O, zero wall-clock reads, zero async runtime dependencies, and zero internal crate dependencies.
- `crates/ports` defines traits and domain value types only; leaf implementation crates (`sqlite`, `acp`, `worktree`, `engine`, `backend`) depend on `lody-ports` and never on `lody-kernel`, `lody-runtime`, `lody-entry`, or each other.
- `crates/entry` depends on `lody-app` only; `bins/lody` is the sole composition root, and its default build must not link `lody-backend` (`connected` Cargo feature only).
- Define and read all environment variable keys and values exclusively inside `crates/env` (`lody-env`); direct calls to `std::env::var*` or `std::env::set_var` outside `lody-env` are forbidden and rejected by `clippy.toml`.
- Preserve existing SQLite filenames and schemas during the rollout so a shared `LODY_DATA_DIR` can switch between the Node CLI and the Rust daemon without data loss.
- Do not create substitute SQLite, JSON, or in-memory implementations for Loro documents, Flock catalogs, or Roost session history; keep `crates/engine` as explicit `Unavailable` port stubs until the official Rust implementations are integrated.
- `SessionId` values are globally unique across workspaces; do not add extra path nesting, disambiguation queries, or tests assuming two workspaces share the same `SessionId`.

## Engineering, code style, and testing rules

- During this early implementation stage, keep designs direct and avoid obsessing over minor edge details or adding premature defensive code for rare scenarios that are unlikely to occur; let real issues surface early and address them when evidenced.
- Prefer mature, well-established third-party crates from the Rust ecosystem instead of implementing general-purpose functionality from scratch; ask the developer whenever a third-party crate choice is uncertain.
- Do not blindly call `.clone()` merely to bypass the borrow checker. Cloning small value types or preserving clean architectural boundaries is acceptable when deliberate, but always evaluate borrowing (`&T` / slices) or reference-counted wrappers (`Rc` / `Arc`) first to avoid unnecessary copies.
- Do not write code comments, including comments for special or subtle logic; express intent through module structure, types, and names.
- Treat 3,000 lines as the single-file complexity ceiling; once any file exceeds 3,000 lines, refactor and split its responsibilities into smaller modules.
- Do not write exhaustive tests covering every capability. Write tests only for explicit business or logical assumptions independent of implementation mechanics—such as assumed maximum bounds, mutual-exclusion invariants where two states or events must never co-occur, or network-independence assumptions—and omit routine capability tests.
- Conformance sandboxes drive targets through external process boundaries with isolated `LODY_DATA_DIR` and `HOME` directories, use explicit file barriers instead of sleeps, and terminate spawned processes before teardown completes.

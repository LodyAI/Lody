# Run the git credential helper under the CLI runtime

Status: implemented
Translation: pending

## Abstract

GitHub repo Sessions failed to start on Macs where the desktop was launched from the
Dock: token prefetch and the credential broker both succeeded, but git aborted the bare
clone with `terminal prompts disabled`, surfacing as `turn_pre_prompt_failed`. The cause
was `credential.helper = !node "<helper.cjs>"`, a PATH lookup — a GUI-launched app
inherits the Dock's minimal PATH, which usually has no `node`, so the helper never ran
and git found no username under `GIT_TERMINAL_PROMPT=0`. Lody now builds the helper
command from `process.execPath` with both words quoted, spawns the diagnostic probe with
the same runtime, and sets `ELECTRON_RUN_AS_NODE=1` on git children when the CLI is the
Electron binary. Container helpers still use `node`, which is on PATH inside the image.

## Decision and ownership

The CLI already resolves its own Node this way for CLI/MCP/adapter and watch-worker
spawns (`agent-client.ts`, `workspace-watch-coordinator.ts`); the host git credential
helper was the only remaining child that depended on an ambient PATH. Making it consistent
was preferred over the alternatives considered:

- **Embedding a second Node runtime** or symlinking `~/.lody/bin/node`: adds installed
  bytes, an update path, and a host-writable executable that git would execute.
- **Resolving PATH from a login shell**: the CLI already has a login-shell env helper, but
  it is slow, shell-configuration dependent, and still fails for users with no `node`
  installed at all — which packaged desktop users legitimately are.

Two details are not optional. Both words are quoted because installation directories
contain spaces (`Lody Helper`, `Program Files`), and on Windows backslashes become forward
slashes: git runs the `!` form through its bundled MinGW bash, where `\` escapes rather
than separates. `ELECTRON_RUN_AS_NODE` must reach the git child, the probe, and the ACP
session environment, or `process.execPath` starts a second GUI app instead of executing
the helper script.

The diagnostic probe (`runCredentialHelperProbe`) had the same `spawn('node', …)` bug. It
mattered twice over: on an affected machine the probe reported a spawn error rather than
the broker verdict, and on a machine that happens to have a PATH `node` the probe would
have succeeded against a runtime git never used, hiding the defect being diagnosed. The
broker routing rules in [worktree/AGENTS.md](../../../../apps/cli/src/session/worktree/AGENTS.md)
are unchanged; this is a separate failure with the same visible symptom, so a
`terminal prompts disabled` report now has two distinct causes to separate.

## Verification

`git-credential-helper-script.test.ts` runs real `git credential fill` against the produced
helper value, with the helper under a directory containing a space and a failing `node`
shim prepended to PATH — the Dock environment without depending on the machine's real
PATH. Reverting the fix reproduces the exact production error,
`fatal: could not read Username for 'https://…': terminal prompts disabled`. The Windows
separator rule is covered by formatting assertions, since the integration test needs a
POSIX shim and is skipped on win32; native Windows desktop startup remains unverified.

`worktree-manager-broker-auth.test.ts` covers the host git argv, the probe's spawn command,
and `ELECTRON_RUN_AS_NODE` propagation; `session-manager.test.ts` covers `GIT_CONFIG_VALUE_1`
and the same flag on the ACP session environment. Every new assertion was ablated
individually against the pre-fix code and fails without it. Run on macOS with Vitest 3.2.4.

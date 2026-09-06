/**
 * How long the MACHINE may take to answer one ACP startup round-trip.
 *
 * A client that also runs its own deadline over the same request needs these
 * numbers, or the two clocks disagree about who owns the truth. That is not
 * hypothetical: the Electron local transport used a 120s socket timeout while
 * the machine could still be inside a 300s cold `npx` init, so the client
 * reported a timeout for a request the machine was still working on and would
 * have answered — including its real failure reason — a few minutes later.
 *
 * The machine owns the deadline. A client budget derived from these constants
 * is a backstop for a daemon that died without replying, never a competing
 * deadline, so it must stay strictly larger than the machine's worst case.
 */

/** Hard timeout on ACP `initialize` for an already-installed runtime. */
export const ACP_INIT_TIMEOUT_MS = 120_000;

/**
 * `initialize` for a registry agent distributed through `npx`, whose first run
 * may still be resolving and unpacking the package tree.
 */
export const ACP_COLD_NPX_INIT_TIMEOUT_MS = 300_000;

/** Hard timeout on ACP `session/new`, which starts the agent's own subprocesses. */
export const ACP_NEW_SESSION_TIMEOUT_MS = 120_000;

/**
 * Attempts `runNpxStartupWithRecovery` may spend on one startup request.
 *
 * A cold `initialize` timeout, npm cache corruption, stale package metadata, or
 * a broken install each purge and retry, and every retry starts a fresh
 * process that gets the full per-attempt timeouts again.
 */
export const ACP_NPX_STARTUP_MAX_ATTEMPTS = 3;

/**
 * Worst-case machine time for ONE startup attempt: the slowest `initialize`
 * followed by `session/new`.
 *
 * Runtime download is deliberately excluded. It streams progress frames, so an
 * inactivity-based transport timeout is continuously reset while it runs and a
 * slow download cannot expire the request.
 */
export const ACP_STARTUP_ATTEMPT_MACHINE_BUDGET_MS =
  ACP_COLD_NPX_INIT_TIMEOUT_MS + ACP_NEW_SESSION_TIMEOUT_MS;

/**
 * Terminating the failed child (a 3s SIGTERM grace) and purging the npx/npm
 * cache directories before the next attempt. Not covered by either ACP timeout,
 * and the retry loop emits no progress frame across it, so it is silence the
 * client budget has to absorb like any other.
 */
const ACP_STARTUP_ATTEMPT_CLEANUP_MS = 10_000;

/**
 * Worst-case machine time for a capability refresh: every attempt the recovery
 * policy is allowed to make, plus the cleanup between them.
 *
 * Budgeting a single attempt is what makes a client backstop lie. The machine
 * treats a cold `initialize` timeout as a reason to purge and try again, so a
 * one-attempt budget expires while the machine is still executing its intended
 * recovery — and the user is told "timed out" instead of the reason the machine
 * would have reported on attempt three.
 */
export const ACP_CAPABILITIES_REFRESH_MACHINE_BUDGET_MS =
  ACP_NPX_STARTUP_MAX_ATTEMPTS * ACP_STARTUP_ATTEMPT_MACHINE_BUDGET_MS +
  (ACP_NPX_STARTUP_MAX_ATTEMPTS - 1) * ACP_STARTUP_ATTEMPT_CLEANUP_MS;

/** Headroom for process spawn, teardown, and transport overhead. */
const CLIENT_BACKSTOP_MARGIN_MS = 30_000;

/**
 * Client-side backstop for one `machine/acp-capabilities-refresh`. Larger than
 * {@link ACP_CAPABILITIES_REFRESH_MACHINE_BUDGET_MS} on purpose: reaching it
 * means the machine never replied at all.
 */
export const ACP_CAPABILITIES_REFRESH_CLIENT_BACKSTOP_MS =
  ACP_CAPABILITIES_REFRESH_MACHINE_BUDGET_MS + CLIENT_BACKSTOP_MARGIN_MS;

import { z } from 'zod';
import type {
  MemoryAgent,
  MemoryAgentIntegration,
  MemoryAgentNotice,
  MemoryInstallFailure,
  MemoryProviderResponse,
} from '@lody/shared';
import type { MemoryCommandRunner, MemoryProvider } from './memory-providers';
import { ensureEverMeNode } from './everme-node';
import { runEvercli, runNpm } from './memory-providers';

/**
 * Lody agentType -> EverMe platform. EverMe installs hooks where the harness
 * has them, which is what makes recall and capture automatic; everywhere else
 * it registers its MCP server and the model has to reach for the tools. Agents
 * EverMe does not cover are absent here and never render a connect button.
 */
const EVERME_AGENTS: readonly {
  id: string;
  displayName: string;
  platform: string;
  integration: MemoryAgentIntegration;
  /** Other agentTypes Lody may report for the same harness. */
  aliases?: readonly string[];
}[] = [
  {
    id: 'claude',
    displayName: 'Claude Code',
    platform: 'claude-code',
    integration: 'hook',
    // `claude-p` drives the user's own Claude Code through a pty, so it reads
    // the same `~/.claude` this platform installs into.
    aliases: ['claude-p'],
  },
  { id: 'codex', displayName: 'Codex', platform: 'codex', integration: 'hook' },
  {
    id: 'kimi',
    displayName: 'Kimi Code',
    platform: 'kimicode',
    integration: 'mcp',
    aliases: ['kimi-code'],
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    platform: 'opencode',
    integration: 'mcp',
    // V2 ships the same `opencode acp` binary from the same vendor, so it
    // reads the same config this platform writes.
    aliases: ['opencode-v2'],
  },
  // Registry agents, keyed by the id Lody's own registry gives them
  // (packages/shared/src/acp/registry-generated.ts) — the names differ from
  // EverMe's platforms, so neither side can be derived from the other.
  {
    id: 'minimax-code',
    displayName: 'MiniMax Code',
    platform: 'minimaxcode',
    // `@everme/minimaxcode` installs pre/post-tool-use hooks, so capture is
    // automatic here even though an MCP server is registered alongside them.
    integration: 'hook',
  },
  { id: 'cursor', displayName: 'Cursor', platform: 'cursor', integration: 'mcp' },
  { id: 'devin', displayName: 'Devin', platform: 'devin', integration: 'mcp' },
  { id: 'pi', displayName: 'Pi', platform: 'pi', integration: 'mcp' },
  { id: 'deepseek', displayName: 'DeepSeek Harness', platform: 'dsh', integration: 'mcp' },
];

/**
 * The transport caps a memory request at 60s, so a batch that would outlast it
 * stops early and reports the rest as untouched rather than failing wholesale.
 *
 * The budget is spent from the moment the request arrives and has to cover the
 * two inventories that bracket the loop as well as the command in flight when
 * the deadline passes — each of which may take the runner's full 20s. Starting
 * the clock after the first inventory, and checking it only before starting a
 * command, let a batch reach ~100s: the transport gave up, the panel greyed
 * every row out, and the connects had in fact succeeded on disk.
 */
const EVERME_BATCH_BUDGET_MS = 60_000;
/** What the runner may spend on one EverCLI call. */
const EVERME_CALL_BUDGET_MS = 20_000;

/**
 * How long to keep polling when EverCLI never says how long its code lives.
 * Only a bound on Lody's own waiting: the code's real deadline is the
 * backend's, and the poll stops the moment EverCLI calls the code spent.
 */
const EVERME_SIGN_IN_FALLBACK_MS = 15 * 60_000;

/**
 * The npm wrapper, not the binary: its postinstall picks the build for this
 * platform, checksums it, and leaves `evercli` wherever npm puts global bins.
 */
const EVERME_PACKAGE = '@everme/cli';

/**
 * What a failed global install can be told apart by. A spawn that found no
 * npm reports `ENOENT` as its code; npm itself prints `EACCES` (or `EPERM` on
 * Windows) when the global folder belongs to another user, which Lody cannot
 * fix from here and the user can fix in one command.
 */
const installFailure = (
  result: Awaited<ReturnType<MemoryCommandRunner>>
): MemoryInstallFailure | undefined => {
  if (result.code === 'ENOENT') return 'npm_missing';
  return /\bE(?:ACCES|PERM)\b/.test(`${result.stderr ?? ''}\n${result.stdout}`)
    ? 'permission'
    : undefined;
};

/** `pending` and `approved` share a payload; which fields arrive says which. */
const EvercliSignInSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    status: z.string().min(1),
    userCode: z.string().min(1).optional(),
    verificationUrl: z.string().min(1).optional(),
    expiresInSec: z.number().int().positive().optional(),
    deviceCode: z.string().min(1).optional(),
  }),
});

/**
 * The page is handed to a browser, so only the schemes a browser opens leave
 * here. Checked at the source rather than at the window: whatever the UI does
 * with it, an approval page that is not a web page is already wrong.
 */
const isWebPage = (value: string | undefined): value is string => {
  if (!value) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
};

/**
 * EverCLI ends a device flow on an auth-typed error and retries through
 * everything else; a poll that treated a dropped connection as a dead code
 * would throw away a flow the user has already approved.
 */
const isSpentDeviceCode = (stdout: string): boolean => {
  try {
    const parsed = z
      .object({ ok: z.literal(false), error: z.object({ type: z.string() }) })
      .safeParse(JSON.parse(stdout) as unknown);
    return parsed.success && ['auth', 'not_logged_in'].includes(parsed.data.error.type);
  } catch {
    // Unreadable output names no reason to stop, and the deadline still will.
    return false;
  }
};

const EvercliPlatformsSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    platforms: z.array(
      z.object({
        platform: z.string().min(1),
        installed: z.boolean().optional(),
        hasEverMeEntry: z.boolean().optional(),
        registeredAgent: z.object({ connectionStatus: z.string().optional() }).nullish(),
      })
    ),
  }),
});
type EvercliPlatform = z.infer<typeof EvercliPlatformsSchema>['data']['platforms'][number];

export function createEverMeMemoryProvider(
  run: MemoryCommandRunner = runEvercli,
  runInstall: MemoryCommandRunner = runNpm,
  provisionNode: () => Promise<void> = ensureEverMeNode
): MemoryProvider {
  const resolve = (target: string) =>
    EVERME_AGENTS.find((entry) => entry.id === target || entry.aliases?.includes(target));

  /**
   * The flow Lody opened, held on the machine that opened it. The device code
   * is the half that claims an account, so it stays beside the EverCLI that
   * will spend it rather than travelling to a browser and back.
   */
  let flow: { deviceCode: string; expiresAt: number } | undefined;

  /**
   * The install this machine is running, if any. Fetching a binary outlasts
   * the request that asked for it, so the job is left here to be asked after
   * rather than held open across a reply nobody is waiting on any more.
   */
  let job:
    | {
        running: boolean;
        failed: boolean;
        step: 'runtime' | 'provider';
        failure?: MemoryInstallFailure;
      }
    | undefined;
  /** A click that has decided to install but not yet started one. */
  let claiming = false;
  /** Last account the probe saw, so reading it costs no extra EverCLI call. */
  let account: string | undefined;

  const inventory = async (): Promise<Map<string, EvercliPlatform>> => {
    const result = await run(['plugin', 'list', '--no-prompt', '--format', 'json']);
    if (result.code !== undefined)
      throw new Error('EverMe could not list its agents. Refresh its status and try again.');
    const parsed = EvercliPlatformsSchema.parse(JSON.parse(result.stdout));
    return new Map(parsed.data.platforms.map((entry) => [entry.platform, entry]));
  };

  const describe = (row: EvercliPlatform | undefined): MemoryAgentNotice | undefined => {
    if (!row) return 'absent_on_machine';
    if (row.hasEverMeEntry !== true) return undefined;
    return row.registeredAgent?.connectionStatus === 'disconnected'
      ? 'cloud_disconnected'
      : undefined;
  };

  const toAgents = (
    rows: Map<string, EvercliPlatform>,
    notes: Map<string, MemoryAgentNotice>,
    mode?: 'install' | 'uninstall'
  ): MemoryAgent[] =>
    EVERME_AGENTS.map((entry) => {
      const row = rows.get(entry.platform);
      const connected = row?.hasEverMeEntry === true;
      // The refreshed inventory outranks the exit code. EverCLI can report
      // trouble — a host registry it could not reach, a backend that answered
      // late — and still have written the config, so a row that reached the
      // state the click asked for must never also claim the click failed.
      const note =
        mode !== undefined && (mode === 'install') === connected
          ? undefined
          : notes.get(entry.platform);
      const notice = note ?? describe(row);
      const agent: MemoryAgent = {
        id: entry.id,
        displayName: entry.displayName,
        integration: entry.integration,
        supported: true,
        connectable: row !== undefined,
        connected,
        ...(entry.aliases ? { aliases: [...entry.aliases] } : {}),
      };
      return notice === undefined ? agent : { ...agent, notice };
    });

  const apply = async (
    targets: readonly string[],
    mode: 'install' | 'uninstall'
  ): Promise<MemoryAgent[]> => {
    // Started before the first inventory, and holding back enough for the
    // command that may already be running plus the inventory that closes the
    // batch, so the whole reply still fits inside what the transport allows.
    const deadline = Date.now() + EVERME_BATCH_BUDGET_MS - 2 * EVERME_CALL_BUDGET_MS;
    const rows = await inventory();
    const notes = new Map<string, MemoryAgentNotice>();
    const handled = new Set<string>();
    for (const target of targets) {
      const entry = resolve(target);
      // Aliases share a platform; installing it twice would rotate its token.
      if (!entry || handled.has(entry.platform)) continue;
      handled.add(entry.platform);
      const row = rows.get(entry.platform);
      // Absent from EverMe's own list, so the row is inert in the UI. `--force`
      // would still register it and mint a token for a harness nobody has.
      if (!row) continue;
      const connected = row.hasEverMeEntry === true;
      // Every install issues a new agent token, so a no-op click stays a no-op.
      if (mode === 'install' ? connected : !connected) continue;
      if (Date.now() > deadline) {
        notes.set(entry.platform, 'deferred');
        continue;
      }
      const args =
        mode === 'install'
          ? ['plugin', 'install', entry.platform, '--no-prompt', '--format', 'json']
          : ['plugin', 'uninstall', entry.platform, '--yes', '--no-prompt', '--format', 'json'];
      // EverCLI detects agents on PATH; Lody's managed binaries are not there.
      if (mode === 'install' && row.installed !== true) args.push('--force');
      // Serial on purpose: EverCLI rewrites one shared config file per agent.
      const result = await run(args);
      if (result.code !== undefined)
        notes.set(entry.platform, mode === 'install' ? 'connect_failed' : 'disconnect_failed');
    }
    // Report the inventory EverMe now holds, not the one the UI started from.
    return toAgents(await inventory(), notes, mode);
  };

  /** Reads EverCLI's own cached login state; no network call of its own. */
  const probe = async (): Promise<MemoryProviderResponse['status']> => {
    const result = await run(['auth', 'status', '--no-prompt', '--format', 'json']);
    if (result.code === 'ENOENT') return 'not_installed';
    try {
      const parsed = z
        .object({
          ok: z.boolean(),
          data: z
            .object({ accountId: z.string().min(1), email: z.string().min(1).optional() })
            .nullish(),
        })
        .parse(JSON.parse(result.stdout));
      // A readable envelope without an account means installed but signed out.
      account = parsed.data?.email ?? parsed.data?.accountId;
      return parsed.ok && parsed.data ? 'ready' : 'not_running';
    } catch {
      // Only an envelope that parsed can say nobody is signed in. An exit code
      // with output we could not read is a broken EverCLI, and calling that
      // "signed out" offers a second sign-in to an account that has one.
      return 'error';
    }
  };

  return {
    id: 'everme',
    probe,
    /** One account holds one memory, so EverMe exposes no identities to pick. */
    list: async () => [],
    create: async () => {
      throw new Error('EverMe memories are created in EverMe, not in Lody.');
    },
    update: async () => {
      throw new Error('EverMe memories are edited in EverMe, not in Lody.');
    },
    agents: async () => toAgents(await inventory(), new Map()),
    /** Set by the probe that runs ahead of every read, so never stale here. */
    account: () => account,
    connect: (targets) => apply(targets, 'install'),
    disconnect: (targets) => apply(targets, 'uninstall'),
    /**
     * Device Flow, started but not awaited: approval happens in a browser, and
     * a request that blocked on it would outlive the transport long before the
     * user finished reading the page.
     */
    async signIn() {
      // A machine already signed in has nothing to approve, and a second flow
      // through it would mint a second key for an account that has one. Say
      // so rather than acting: the UI moves on either way.
      const before = await probe();
      if (before === 'ready') return { status: 'approved' };
      // A probe that could not be read is not permission to start a flow: the
      // machine may well be signed in, and a second flow would mint a second
      // key for an account that already has one.
      if (before === 'error')
        throw new Error('EverMe could not be read on this machine. Refresh its status and retry.');
      const result = await run(['auth', 'login', '--no-wait', '--no-prompt', '--format', 'json']);
      if (result.code !== undefined)
        throw new Error('EverMe could not start a sign-in. Check EverCLI and try again.');
      const { data } = EvercliSignInSchema.parse(JSON.parse(result.stdout));
      if (data.status !== 'pending' || !data.deviceCode || !isWebPage(data.verificationUrl))
        throw new Error('EverMe did not return a page to approve the sign-in on.');
      flow = {
        deviceCode: data.deviceCode,
        expiresAt:
          Date.now() + (data.expiresInSec ? data.expiresInSec * 1000 : EVERME_SIGN_IN_FALLBACK_MS),
      };
      return {
        status: 'pending',
        verificationUrl: data.verificationUrl,
        ...(data.userCode ? { userCode: data.userCode } : {}),
        ...(data.expiresInSec ? { expiresInSec: data.expiresInSec } : {}),
      };
    },
    async signInPoll() {
      // No flow to finish: either none was started here, or this process was
      // restarted since. Both end the same way — the user starts a fresh one.
      if (!flow) return { status: 'expired' };
      if (Date.now() > flow.expiresAt) {
        flow = undefined;
        return { status: 'expired' };
      }
      const code = flow.deviceCode;
      const result = await run([
        'auth',
        'login',
        '--device-code',
        code,
        '--no-prompt',
        '--format',
        'json',
      ]);
      if (result.code !== undefined) {
        // Only EverCLI calling the code spent ends the flow. A refused
        // connection is worth another poll; the deadline above ends the rest.
        if (!isSpentDeviceCode(result.stdout)) return { status: 'pending' };
        flow = undefined;
        return { status: 'expired' };
      }
      const { data } = EvercliSignInSchema.parse(JSON.parse(result.stdout));
      if (data.status === 'pending') return { status: 'pending' };
      flow = undefined;
      return { status: data.status === 'approved' ? 'approved' : 'expired' };
    },
    async install() {
      // A second click while one is running rejoins it. Two global installs
      // of the same package at once would race over the same bin directory.
      if (job?.running) return { status: 'running', step: job.step };
      if (claiming) return { status: 'running' };
      // Claimed before anything is awaited, so two clicks cannot both find the
      // slot empty and each spawn a global install over one bin directory. It
      // is kept apart from `job` because an empty `job` means "this install
      // failed", which a click that has not started one yet has not done.
      claiming = true;
      try {
        // An EverCLI that answers is left alone: a machine that has one has
        // connected agents behind it, and this click never asked to disturb
        // them. `error` is the exception — something is there but cannot be
        // read, and fetching the current build is the usual way out of that.
        const before = await probe();
        if (before !== 'not_installed' && before !== 'error') return { status: 'done' };
      } finally {
        claiming = false;
      }
      // No await between dropping the claim and taking the slot, so nothing
      // can slip in and start a second install.
      const started: NonNullable<typeof job> = { running: true, failed: false, step: 'provider' };
      job = started;
      const args = ['install', '--global', EVERME_PACKAGE];
      void (async () => {
        let result = await runInstall(args);
        let failure = result.code === undefined ? undefined : installFailure(result);
        // No npm, or a global folder this user cannot write: both are fixed by
        // a Node.js of the user's own, so Lody puts one in place and tries
        // again on it. The runner picks it up by itself once it exists.
        if (failure) {
          started.step = 'runtime';
          const provisioned = await provisionNode().then(
            () => true,
            () => false
          );
          started.step = 'provider';
          if (provisioned) {
            result = await runInstall(args);
            failure = result.code === undefined ? undefined : installFailure(result);
          }
        }
        started.failed = result.code !== undefined;
        if (started.failed) started.failure = failure;
      })()
        .catch(() => {
          started.failed = true;
        })
        .finally(() => {
          started.running = false;
        });
      return { status: 'running', step: 'provider' };
    },
    // Async only to match its other half, so the caller can reach either by
    // name; asking after a job is reading a flag, not work.
    async installPoll() {
      // Nothing started here, so there is nothing to report as still going.
      // Claimed but not started yet: the click that claimed it is still
      // deciding, and calling that a failure would strand a second window.
      if (claiming) return { status: 'running' };
      if (!job) return { status: 'failed' };
      if (job.running) return { status: 'running', step: job.step };
      if (!job.failed) return { status: 'done' };
      return job.failure ? { status: 'failed', failure: job.failure } : { status: 'failed' };
    },
    /** Credentials stay in EverMe's own per-machine config; nothing is injected. */
    environment: () => ({}),
  };
}

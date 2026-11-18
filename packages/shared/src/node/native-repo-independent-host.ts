import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { ChildProcess as Command, ChildProcessSpawner } from 'effect/process';
import { Clock, Context, Effect, Layer, Schema } from 'effect';
import { NodeProcess, runCommandOk, READ_ONLY_ABANDON_POLICY } from './process';
import { connectEngine, readEngineEndpoint } from '@loro-dev/loro-repo-client/node';
import type { RepoClient } from '@loro-dev/loro-repo-client';
import {
  IndependentRepoControlChannel,
  IndependentRepoControlError,
  prepareIndependentRepoDirectory,
  readIndependentRun,
  independentRunSchema,
  readIndependentPrivateJson,
  independentRunPath,
} from './native-repo-independent-control';

export type IndependentNativeRepoOptions = {
  readonly dataDir: string;
  /** Complete account/workspace/protection installation binding, supplied by trusted composition. */
  readonly binding: string;
  readonly executable: string;
  readonly entry: string;
  readonly startupTimeoutMs?: number;
  /** Require this exact trusted SDK build in the authenticated engine generation. */
  readonly requiredSdkArtifactId?: string;
  /** Candidate handoff protocol. Windows stays gated unless a trusted Node
   * acceptance harness explicitly selects it; no renderer/product flag. */
  readonly experimentalBrokeredHandoff?: true;
};
export type IndependentNativeRepoLease = {
  /** Trusted Node domain owners only; never export this SDK handle to a renderer. */
  readonly client: RepoClient;
  readonly engineRunId: string;
  readonly controlId: string;
  readonly sdkArtifactId?: string;
  readonly pid: number;
  /** Connection loss invalidates this generation; reacquisition uses a new Scope. */
  readonly lost: Effect.Effect<void>;
  /** Trusted whole-workspace retirement, never an observer's ordinary close. */
  readonly retireWorkspace: Effect.Effect<void, unknown>;
};
export class IndependentNativeRepo extends Context.Service<
  IndependentNativeRepo,
  IndependentNativeRepoLease
>()('lody/node/IndependentNativeRepo') {}

/** The failed observer retains its own channel until actual local close is confirmed. */
export class IndependentRepoLeaseReleaseFailed extends Error {
  constructor(
    override readonly cause: unknown,
    readonly retryCleanup: () => Promise<void>
  ) {
    super('Independent native Repo lease release was unconfirmed');
  }
}

const io = <A>(operation: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (error) => error });
const retryable = (error: unknown): boolean => {
  if (error instanceof IndependentRepoControlError)
    return ['starting', 'draining', 'disconnected', 'connect_timeout', 'request_timeout'].includes(
      error.code
    );
  return ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(
    (error as NodeJS.ErrnoException)?.code ?? ''
  );
};

const hostEnvironment = () =>
  Object.fromEntries(
    ['PATH', 'SystemRoot', 'TMPDIR', 'TMP', 'TEMP', 'NO_PROXY', 'no_proxy']
      .flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]]))
      .concat([['ELECTRON_RUN_AS_NODE', '1']])
  );
// Read-only Windows ACL probe. Paths go over stdin, never into shell code. A
// null DACL or an Allow ACE outside the user/SYSTEM/Administrators boundary
// fails before an engine or credential-bearing run file is created.
const privateAclProbe = `$ErrorActionPreference='Stop';$r=[Console]::In.ReadToEnd()|ConvertFrom-Json;$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$allowed=@($sid,'S-1-5-18','S-1-5-32-544');foreach($p in $r.paths){if(!(Test-Path -LiteralPath $p)){continue};$acl=Get-Acl -LiteralPath $p;$raw=[System.Security.AccessControl.RawSecurityDescriptor]::new($acl.Sddl);if($null -eq $raw.DiscretionaryAcl){throw 'private profile required'};foreach($ace in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($ace.AccessControlType -eq 'Allow' -and $allowed -notcontains $ace.IdentityReference.Value){throw 'private profile required'}}};[Console]::Out.Write('{"version":1,"private":true}')`;
const privateAclReceipt = Schema.Struct({
  version: Schema.Literal(1),
  private: Schema.Literal(true),
});
const checkWindowsProfilePrivacy = Effect.fnUntraced(function* (dataDir: string) {
  const existing = yield* io(async () => {
    let current = path.resolve(dataDir);
    for (;;) {
      try {
        const stat = await lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new IndependentRepoControlError('private_path_required');
        return current;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) throw new IndependentRepoControlError('private_path_required');
      current = parent;
    }
  });
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot))
    return yield* Effect.fail(new IndependentRepoControlError('windows_system_root_unavailable'));
  const result = yield* runCommandOk({
    command: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(privateAclProbe, 'utf16le').toString('base64'),
    ],
    input: JSON.stringify({
      paths: [
        existing,
        path.join(dataDir, 'independent-mode.json'),
        path.join(dataDir, 'independent-run.json'),
        path.join(dataDir, 'engine.json'),
      ],
    }),
    timeout: '5 seconds',
    maxOutputBytes: 1024,
    abandonPolicy: READ_ONLY_ABANDON_POLICY,
  });
  yield* Effect.try({
    try: () =>
      Schema.decodeUnknownSync(privateAclReceipt)(JSON.parse(result.stdout.toString('utf8'))),
    catch: () => new IndependentRepoControlError('windows_private_profile_required'),
  });
});

/** Middle launcher owns its controller until actual ready discovery, then
 * hands it off and exits. The bootstrap client must observe THIS process's
 * exit before activating the controller and admitting any second lease. */
export const launchIndependentRepoBroker = Effect.fnUntraced(function* (options: {
  dataDir: string;
  startupId: string;
  executable: string;
  entry: string;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    Command.make(
      options.executable,
      [options.entry, options.dataDir, options.startupId, '--brokered-controller'],
      {
        detached: true,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
        extendEnv: false,
        env: hostEnvironment(),
        windowsHide: true,
        killSignal: 'SIGKILL',
        forceKillAfter: 0,
      }
    )
  );
  const deadline = (yield* Clock.currentTimeMillis) + 10_000;
  while ((yield* Clock.currentTimeMillis) < deadline) {
    const ready = yield* io(async () => {
      try {
        const run = independentRunSchema.parse(
          await readIndependentPrivateJson(independentRunPath(options.dataDir))
        );
        return (
          run.startupId === options.startupId &&
          run.handoff === 'brokered-v1' &&
          run.launcherPid === process.pid &&
          run.pid === Number(child.pid)
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return false;
      }
    });
    if (ready) {
      yield* child.unref;
      return;
    }
    if (!(yield* child.isRunning))
      return yield* Effect.fail(new IndependentRepoControlError('broker_controller_exited'));
    yield* Effect.sleep('25 millis');
  }
  return yield* Effect.fail(new IndependentRepoControlError('broker_controller_timeout'));
});

/**
 * The fixed independent process owns its engine, while each application Scope
 * owns only a private control lease and SDK connection. A launcher retains its
 * normal process cleanup authority until a bootstrap lease is acknowledged.
 */
export const acquireIndependentNativeRepo = Effect.fnUntraced(function* (
  options: IndependentNativeRepoOptions
) {
  // Windows taskkill /T follows parentage despite Node detached/unref. Until
  // a brokered launcher is accepted on Windows, never claim this handoff is
  // independent from execution-tree termination there.
  const nodeProcess = yield* NodeProcess;
  const platform = nodeProcess.platform;
  if (platform === 'win32' && !options.experimentalBrokeredHandoff) {
    return yield* Effect.fail(
      new IndependentRepoControlError('windows_independent_handoff_unavailable')
    );
  }
  if (platform === 'win32') yield* checkWindowsProfilePrivacy(options.dataDir);
  const dataDir = yield* io(() =>
    prepareIndependentRepoDirectory(options.dataDir, options.binding)
  );
  const startupId = yield* Effect.sync(() => randomUUID());
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const deadline = (yield* Clock.currentTimeMillis) + (options.startupTimeoutMs ?? 15_000);
  let launched: ChildProcessSpawner.ChildProcessHandle | undefined;
  const control = yield* Effect.acquireRelease(
    Effect.gen(function* () {
      let last: unknown;
      while ((yield* Clock.currentTimeMillis) < deadline) {
        const attempt = yield* io(async (signal) => {
          const run = await readIndependentRun(dataDir, options.binding);
          const channel = await IndependentRepoControlChannel.open(run, signal);
          try {
            const reply = await channel.request(
              'acquire',
              launched && run.startupId === startupId ? startupId : undefined
            );
            if (
              reply.type !== 'leased' ||
              reply.controlId !== run.controlId ||
              reply.engineRunId !== run.engineRunId ||
              reply.pid !== run.pid ||
              reply.handoff !== run.handoff ||
              reply.launcherPid !== run.launcherPid ||
              reply.sdkArtifactId !== run.sdkArtifactId
            ) {
              throw new IndependentRepoControlError('generation_mismatch');
            }
            if (
              options.requiredSdkArtifactId !== undefined &&
              reply.sdkArtifactId !== options.requiredSdkArtifactId
            ) {
              throw new IndependentRepoControlError('sdk_artifact_mismatch');
            }
            return { run, channel, bootstrap: reply.bootstrap };
          } catch (error) {
            channel.destroy();
            throw error;
          }
        }).pipe(Effect.result);
        if (attempt._tag === 'Success') return attempt.success;
        last = attempt.failure;
        if (!retryable(last)) return yield* Effect.fail(last);
        if (!launched) {
          launched = yield* spawner.spawn(
            Command.make(
              options.executable,
              [
                options.entry,
                dataDir,
                startupId,
                ...(options.experimentalBrokeredHandoff ? ['--launch-broker'] : []),
              ],
              {
                detached: true,
                stdin: 'ignore',
                stdout: 'ignore',
                stderr: 'ignore',
                extendEnv: false,
                env: hostEnvironment(),
                windowsHide: true,
                killSignal: 'SIGKILL',
                forceKillAfter: 0,
              }
            )
          );
        }
        yield* Effect.sleep('50 millis');
      }
      return yield* Effect.fail(
        new IndependentRepoControlError(
          last instanceof IndependentRepoControlError
            ? `startup_timeout_${last.code}`
            : 'startup_timeout'
        )
      );
    }),
    ({ channel }) =>
      io(async () => {
        if (channel.isClosed) return;
        try {
          const reply = await channel.request('release');
          if (reply.type !== 'released')
            throw new IndependentRepoControlError('release_unconfirmed');
        } catch (error) {
          throw new IndependentRepoLeaseReleaseFailed(error, async () => {
            channel.destroy();
            await channel.lost;
          });
        } finally {
          channel.destroy();
          await channel.lost;
        }
      }).pipe(Effect.orDie)
  );
  if (control.bootstrap) {
    if (!launched || control.run.startupId !== startupId) {
      return yield* Effect.fail(new IndependentRepoControlError('bootstrap_owner_mismatch'));
    }
    const launcher = launched;
    // No other lease can be admitted until activate. After the acknowledged
    // lease handoff, closing this Scope must never kill a second client's host.
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* launcher.unref;
        if (control.run.handoff === 'brokered-v1') {
          if (control.run.launcherPid !== Number(launcher.pid))
            return yield* Effect.fail(new IndependentRepoControlError('broker_launcher_mismatch'));
          while (yield* launcher.isRunning) {
            if ((yield* Clock.currentTimeMillis) >= deadline)
              return yield* Effect.fail(new IndependentRepoControlError('broker_exit_unconfirmed'));
            yield* Effect.sleep('25 millis');
          }
          if ((yield* launcher.exitCode) !== 0)
            return yield* Effect.fail(new IndependentRepoControlError('broker_exit_failed'));
        }
        const activated = yield* io(() => control.channel.request('activate', startupId));
        if (activated.type !== 'active')
          return yield* Effect.fail(new IndependentRepoControlError('activation_unconfirmed'));
      })
    );
  }
  const client = yield* Effect.acquireRelease(
    io(async () => {
      const before = await readEngineEndpoint(dataDir);
      if (before.runId !== control.run.engineRunId)
        throw new IndependentRepoControlError('engine_generation_changed');
      const candidate = await connectEngine(dataDir, { autoReconnect: false });
      try {
        const after = await readEngineEndpoint(dataDir);
        if (after.runId !== control.run.engineRunId)
          throw new IndependentRepoControlError('engine_generation_changed');
        return candidate;
      } catch (error) {
        await candidate.close();
        throw error;
      }
    }),
    (client) => io(() => client.close()).pipe(Effect.orDie)
  );
  return {
    client,
    engineRunId: control.run.engineRunId,
    controlId: control.run.controlId,
    ...(control.run.sdkArtifactId ? { sdkArtifactId: control.run.sdkArtifactId } : {}),
    pid: control.run.pid,
    lost: Effect.promise(() => control.channel.lost),
    retireWorkspace: Effect.gen(function* () {
      const alive = () => {
        try {
          nodeProcess.kill(control.run.pid, 0);
          return true;
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')
            return false;
          throw error;
        }
      };
      if (!(yield* Effect.try({ try: alive, catch: (error) => error }))) return;
      // This new channel targets the captured private run, not readIndependentRun.
      // A lost reply may be reconciled by actual exit; it never authorizes a
      // stop of a newly discovered host or a replay of any product mutation.
      let requestFailure: unknown;
      const request = yield* io(async (signal) => {
        const channel = await IndependentRepoControlChannel.open(control.run, signal);
        try {
          const reply = await channel.request('retire_workspace');
          if (reply.type !== 'released' || !reply.hostStopped)
            throw new IndependentRepoControlError('retire_unconfirmed');
        } finally {
          channel.destroy();
          await channel.lost;
        }
      }).pipe(Effect.result);
      if (request._tag === 'Failure') requestFailure = request.failure;
      const stopDeadline = (yield* Clock.currentTimeMillis) + 5_000;
      while (yield* Effect.try({ try: alive, catch: (error) => error })) {
        if ((yield* Clock.currentTimeMillis) >= stopDeadline)
          return yield* Effect.fail(
            new AggregateError(
              [
                new IndependentRepoControlError('retire_exit_unconfirmed'),
                ...(requestFailure === undefined ? [] : [requestFailure]),
              ],
              'Independent native Repo retirement remains unconfirmed'
            )
          );
        yield* Effect.sleep('20 millis');
      }
    }),
  } satisfies IndependentNativeRepoLease;
});

export const independentNativeRepoLayer = (options: IndependentNativeRepoOptions) =>
  Layer.effect(IndependentNativeRepo, acquireIndependentNativeRepo(options));

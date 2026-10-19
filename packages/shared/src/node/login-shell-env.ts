/**
 * The user's login-shell environment, probed once through the process layer.
 *
 * GUI and daemon launches (macOS launchd, Linux .desktop, systemd, npx) inherit
 * a minimal PATH without the directories users install tools into (Homebrew,
 * nvm, volta, `~/.local/bin`, editor CLIs). Both the CLI and the desktop read
 * the login shell's environment to recover them; this is their one probe.
 */
import { userInfo } from 'node:os';

import {
  Cause,
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Scope,
  Semaphore,
} from 'effect';
import { ChildProcessSpawner } from 'effect/process';

import {
  CommandTimedOut,
  ProcessReleaseFailed,
  READ_ONLY_ABANDON_POLICY,
  CommandFailed,
  SpawnFailed,
  errnoCode,
  processLayer,
  runCommandOk,
  type RunCommandError,
  type ProcessFacadeOptions,
} from './process';

const DELIMITER = '_LODY_SHELL_ENV_DELIMITER_';
/** Verbose rc files (`set -x`) write to stderr; that must not fail the probe. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/**
 * Rc files (nvm, conda, oh-my-zsh) can take seconds on a cold login; a shell
 * past this is stuck. One budget for the whole probe, fallbacks included.
 */
const DEFAULT_TIMEOUT = Duration.seconds(15);
/** POSIX shells to try when the default one fails (for example Nushell). */
const FALLBACK_SHELLS = ['/bin/zsh', '/bin/bash'];

/**
 * The script each shell runs. `command env` skips aliases and functions named
 * `env`; `-0` keeps values with newlines intact, with plain `env` for one
 * without it (BusyBox); the delimiters separate the environment from whatever
 * the rc files print. They go through `printf`: macOS `/bin/sh` prints
 * `echo -n X` as `-n X` plus a newline. Interactive login bash reads
 * `~/.bash_profile` but not `~/.bashrc`, where most PATH edits live.
 */
const probeScript = (shell: string): string =>
  `${shell.endsWith('/bash') ? 'source ~/.bashrc >/dev/null 2>&1 || true; ' : ''}` +
  `printf '%s' "${DELIMITER}"; command env -0 2>/dev/null || command env; printf '%s' "${DELIMITER}"; exit`;

/**
 * Keep rc files from blocking the probe (oh-my-zsh auto-update, tmux
 * autostart). The shell prints them back; they are not the user's settings.
 */
const PROBE_ENV: Record<string, string> = {
  DISABLE_AUTO_UPDATE: 'true',
  ZSH_TMUX_AUTOSTARTED: 'true',
  ZSH_TMUX_AUTOSTART: 'false',
};

export const parseLoginShellEnvOutput = (stdout: string): NodeJS.ProcessEnv | null => {
  const section = stdout.split(DELIMITER)[1];
  if (section === undefined) return null;
  const parsed: NodeJS.ProcessEnv = {};
  for (const entry of section.split(section.includes('\0') ? '\0' : '\n')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    parsed[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return Object.keys(parsed).length > 0 ? parsed : null;
};

/** Undo what the probe itself injected: the base value, or nothing. */
const withoutProbeEnv = (
  parsed: NodeJS.ProcessEnv,
  baseEnv: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  const result = { ...parsed };
  for (const key of Object.keys(PROBE_ENV)) {
    if (baseEnv[key] === undefined) delete result[key];
    else result[key] = baseEnv[key];
  }
  return result;
};

const defaultShell = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string => {
  try {
    const { shell } = userInfo();
    if (shell) return shell;
  } catch {
    // No passwd entry (a container user); fall back to the environment.
  }
  return env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
};

export interface LoginShellEnvOptions {
  /**
   * The whole probe's budget, fallback shells included (15 s by default). A
   * shell still running at the deadline is ended with its process tree.
   */
  readonly timeout?: Duration.Input;
  /** The environment the shell starts from; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Defaults to the user's login shell. */
  readonly shell?: string;
}

export class LoginShellHost extends Context.Service<
  LoginShellHost,
  {
    readonly platform: NodeJS.Platform;
    readonly env: Effect.Effect<NodeJS.ProcessEnv>;
    readonly shellFor: (env: NodeJS.ProcessEnv) => Effect.Effect<string>;
  }
>()('lody/LoginShellHost') {}

export const LoginShellHostLive = Layer.succeed(LoginShellHost, {
  platform: process.platform,
  env: Effect.sync(() => ({ ...process.env })),
  shellFor: (env) => Effect.sync(() => defaultShell(env, process.platform)),
});

export class LoginShellEnvironment extends Context.Service<
  LoginShellEnvironment,
  {
    readonly probe: (
      options?: LoginShellEnvOptions
    ) => Effect.Effect<NodeJS.ProcessEnv | null, RunCommandError | CommandFailed>;
  }
>()('lody/LoginShellEnvironment') {}

/** Finite probes own each shell command Scope; caches belong to their application. */
export const LoginShellEnvironmentLive = Layer.effect(
  LoginShellEnvironment,
  Effect.gen(function* () {
    const host = yield* LoginShellHost;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return LoginShellEnvironment.of({
      probe: (options = {}) =>
        Effect.gen(function* () {
          if (host.platform === 'win32') return null;
          const baseEnv = { ...(options.env ?? (yield* host.env)) };
          const first = options.shell ?? (yield* host.shellFor(baseEnv));
          const shells = [first, ...FALLBACK_SHELLS.filter((shell) => shell !== first)];
          const budgetMs = Duration.toMillis(options.timeout ?? DEFAULT_TIMEOUT);
          const deadline = (yield* Clock.currentTimeMillis) + budgetMs;
          for (const shell of shells) {
            const remainingMs = deadline - (yield* Clock.currentTimeMillis);
            if (remainingMs <= 0)
              return yield* Effect.fail(
                new CommandTimedOut({
                  command: shell,
                  message: `Login shell environment probe timed out after ${budgetMs}ms`,
                })
              );
            const output = yield* runCommandOk({
              command: shell,
              args: ['-ilc', probeScript(shell)],
              env: { ...baseEnv, ...PROBE_ENV },
              timeout: remainingMs,
              abandonPolicy: READ_ONLY_ABANDON_POLICY,
              maxOutputBytes: MAX_OUTPUT_BYTES,
            }).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.catchCause(
                (cause): Effect.Effect<undefined, RunCommandError | CommandFailed> => {
                  const error = Cause.findErrorOption(cause);
                  // Only completed exits or an absent candidate are optional fallback.
                  // Timeout, stream/startup errors and mixed release defects stay failures.
                  if (
                    cause.reasons.length === 1 &&
                    Option.isSome(error) &&
                    (error.value instanceof CommandFailed ||
                      (error.value instanceof SpawnFailed &&
                        errnoCode(error.value.cause) === 'ENOENT'))
                  )
                    return Effect.succeed(undefined);
                  return Effect.failCause(cause);
                }
              )
            );
            if (output !== undefined) {
              const parsed = parseLoginShellEnvOutput(output.stdout.toString('utf8'));
              if (parsed) return withoutProbeEnv(parsed, baseEnv);
            }
          }
          return null;
        }),
    });
  })
);

/** Native composition; execution belongs to the application owner. */
export const probeLoginShellEnv = (options: LoginShellEnvOptions = {}) =>
  Effect.flatMap(LoginShellEnvironment, (environment) => environment.probe(options));

export const loginShellEnvLayer = (options: ProcessFacadeOptions = {}) =>
  LoginShellEnvironmentLive.pipe(
    Layer.provideMerge(Layer.merge(LoginShellHostLive, processLayer(options)))
  );

export class LoginShellCacheClosed extends Data.TaggedError('LoginShellCacheClosed') {}
export class LoginShellCacheShutdownFailed extends Data.TaggedError(
  'LoginShellCacheShutdownFailed'
)<{
  cause: Cause.Cause<unknown>;
  releases: ReadonlyArray<ProcessReleaseFailed>;
}> {}
type ProbeError = RunCommandError | CommandFailed;
export const LoginShellCacheReporter = Context.Reference<
  (cause: Cause.Cause<ProbeError>) => Effect.Effect<void>
>('lody/LoginShellCacheReporter', { defaultValue: () => () => Effect.void });
export class LoginShellCache extends Context.Service<
  LoginShellCache,
  {
    readonly get: (
      wait?: Duration.Input
    ) => Effect.Effect<NodeJS.ProcessEnv | null, ProbeError | LoginShellCacheClosed>;
    readonly peek: Effect.Effect<NodeJS.ProcessEnv | null, ProbeError | LoginShellCacheClosed>;
    readonly warmup: Effect.Effect<void, LoginShellCacheClosed>;
    readonly shutdown: Effect.Effect<void, LoginShellCacheShutdownFailed>;
  }
>()('lody/LoginShellCache') {}

/** Application-owned single probe. Cancelling a reader never cancels its siblings. */
export const LoginShellCacheLive = Layer.effect(
  LoginShellCache,
  Effect.gen(function* () {
    const source = yield* LoginShellEnvironment;
    const report = yield* LoginShellCacheReporter;
    const owner = yield* Scope.fork(yield* Effect.scope);
    const serial = yield* Semaphore.make(1);
    const probe = yield* Ref.make<Fiber.Fiber<NodeJS.ProcessEnv | null, ProbeError> | undefined>(
      undefined
    );
    const closed = yield* Ref.make(false);
    const receipt = yield* Ref.make<
      Deferred.Deferred<void, LoginShellCacheShutdownFailed> | undefined
    >(undefined);
    const start = serial
      .withPermit(
        Effect.gen(function* () {
          if (yield* Ref.get(closed)) return yield* Effect.fail(new LoginShellCacheClosed());
          const existing = yield* Ref.get(probe);
          if (existing) return existing;
          const fiber = yield* Effect.forkIn(
            source.probe().pipe(
              Effect.interruptible,
              Effect.tapCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : report(cause).pipe(Effect.catchCause(() => Effect.void))
              )
            ),
            owner
          );
          yield* Ref.set(probe, fiber);
          return fiber;
        })
      )
      .pipe(Effect.uninterruptible);
    const shutdown = Effect.uninterruptible(
      Effect.gen(function* () {
        const claim = yield* serial.withPermit(
          Effect.gen(function* () {
            const existing = yield* Ref.get(receipt);
            if (existing) return { first: false, done: existing };
            const done = yield* Deferred.make<void, LoginShellCacheShutdownFailed>();
            yield* Ref.set(receipt, done);
            yield* Ref.set(closed, true);
            return { first: true, done };
          })
        );
        if (!claim.first) return yield* Deferred.await(claim.done);
        const result = yield* Effect.gen(function* () {
          const fiber = yield* Ref.get(probe);
          // Interrupt first: runCommand's process Scope terminates the shell before
          // joining its result. Do not close/join a blocked producer before this step.
          if (fiber) yield* Fiber.interrupt(fiber);
          const exit = fiber ? yield* Fiber.await(fiber) : Exit.succeed(null);
          const closing = yield* Scope.close(owner, Exit.void).pipe(Effect.exit);
          const causes: Cause.Cause<unknown>[] = [];
          if (Exit.isFailure(exit)) {
            const releases = exit.cause.reasons.flatMap((r) =>
              Cause.isDieReason(r) && r.defect instanceof ProcessReleaseFailed ? [r.defect] : []
            );
            if (releases.length > 0) causes.push(exit.cause);
          }
          if (Exit.isFailure(closing)) causes.push(closing.cause);
          if (causes.length > 0) {
            const cause = causes.reduce(Cause.combine);
            return yield* Effect.fail(
              new LoginShellCacheShutdownFailed({
                cause,
                releases: cause.reasons.flatMap((r) =>
                  Cause.isDieReason(r) && r.defect instanceof ProcessReleaseFailed ? [r.defect] : []
                ),
              })
            );
          }
          return undefined;
        }).pipe(Effect.exit);
        yield* Deferred.done(claim.done, result);
        return yield* result;
      })
    );
    yield* Effect.addFinalizer(() =>
      shutdown.pipe(Effect.catchCause((cause) => Effect.die(Cause.squash(cause))))
    );
    return LoginShellCache.of({
      warmup: start.pipe(Effect.asVoid),
      peek: start.pipe(Effect.flatMap((fiber) => fiber.pollUnsafe() ?? Effect.succeed(null))),
      get: (wait) =>
        start.pipe(
          Effect.flatMap((fiber) => {
            const result = Fiber.await(fiber).pipe(Effect.flatten);
            return wait === undefined
              ? result
              : result.pipe(
                  Effect.timeoutOrElse({ duration: wait, orElse: () => Effect.succeed(null) })
                );
          })
        ),
      shutdown,
    });
  })
);

/** Retry transferred process owners after the application's Scope has closed. */
export const recoverLoginShellCacheShutdown = (
  cause: Cause.Cause<unknown>
): Effect.Effect<void, unknown> => {
  const failed = cause.reasons.flatMap((r) =>
    Cause.isDieReason(r) && r.defect instanceof LoginShellCacheShutdownFailed ? [r.defect] : []
  );
  if (failed.length !== cause.reasons.length || failed.some((error) => error.releases.length === 0))
    return Effect.failCause(cause);
  return Effect.forEach(
    failed.flatMap((error) => error.releases),
    (release) => release.retryTermination(),
    { discard: true }
  );
};

import { Clock, Effect } from 'effect';
import path from 'node:path';
import type { SessionId } from '@lody/shared';
import type {
  AutomationProgramContext,
  AutomationResult,
  AutomationRunExit,
  AutomationWait,
} from '@lody/shared/automations';
import type { Lody } from '@/lib/lody';
import type { Logger } from '@/utils/logger';
import { getCachedLoginShellEnvSyncLegacy } from '@/agent/login-shell-env';
import { platformLayer } from '@/platform/process-options';
import type { SessionAutomationAuthority } from '@/session/session-automation-authority';
import type { AutomationLedger } from '../storage/ledger';
import { readAutomationContext } from '../context/reads-legacy';
import {
  automationCommandEnvironment,
  execAutomationCommand,
  resolveAutomationCwd,
} from '../context/exec';
import { evaluateAutomationProgram } from '../programs/codemode';
import { managedRunResult, type ManagedRuns } from './managed-runs';

/** Tool lookup follows the login shell, as the Agent's own commands do; nothing else is inherited. */
export const managedRunEnvironment = (): NodeJS.ProcessEnv => {
  let shellPath: string | undefined;
  try {
    shellPath = getCachedLoginShellEnvSyncLegacy().PATH;
  } catch {
    shellPath = undefined;
  }
  const entries = [
    ...new Set(
      [shellPath, process.env.PATH]
        .flatMap((value) => value?.split(path.delimiter) ?? [])
        .filter(Boolean)
    ),
  ];
  return automationCommandEnvironment(entries.length ? entries.join(path.delimiter) : undefined);
};

export type WaitEvaluatorDeps = {
  ledger: AutomationLedger;
  lody: Lody;
  authority: SessionAutomationAuthority;
  logger: Logger;
  getManagedRuns(): ManagedRuns | undefined;
  sessionContext(sessionId: string, userId: string): Promise<AutomationProgramContext>;
};

const evaluateRun = (deps: WaitEvaluatorDeps) =>
  Effect.fn('Automations.evaluateRun')(function* (claimed: AutomationWait) {
    const { ledger, lody, getManagedRuns, sessionContext } = deps;
    const wait = ledger.wait(claimed.id) ?? claimed;
    const run = wait.run;
    const owner = getManagedRuns();
    if (!run || !owner) return yield* Effect.fail(new Error('AUTOMATION_RUN_UNAVAILABLE'));
    if (run.exit) return managedRunResult(wait, run.exit);
    if (owner.has(wait.id)) return false as const;
    const now = yield* Clock.currentTimeMillis;
    if (run.startedAt !== undefined) {
      // The owner that started it is gone without observing its exit. Never start it again.
      const exit: AutomationRunExit = {
        endedAt: now,
        outcome: 'interrupted',
        exitCode: null,
        signal: null,
        tail: '',
        logTruncated: false,
      };
      ledger.recordRunExit(wait.id, exit, now);
      return managedRunResult(wait, exit);
    }
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        if (!ledger.claimRunStart(wait.id, now)) return false as const;
        const cwd = yield* Effect.tryPromise(() =>
          sessionContext(wait.sessionId, wait.ownerUserId)
        ).pipe(
          Effect.andThen(
            Effect.tryPromise(() => lody.resolveAutomationWorkdir(wait.sessionId as SessionId))
          ),
          Effect.flatMap((root) =>
            root
              ? resolveAutomationCwd(root, run.cwd)
              : Effect.fail(new Error('AUTOMATION_EXEC_WORKSPACE_UNAVAILABLE'))
          ),
          Effect.result
        );
        if (cwd._tag === 'Failure') {
          const exit: AutomationRunExit = {
            endedAt: now,
            outcome: 'spawn_failed',
            exitCode: null,
            signal: null,
            error: cwd.failure instanceof Error ? cwd.failure.message : 'Run could not start',
            tail: '',
            logTruncated: false,
          };
          ledger.recordRunExit(wait.id, exit, now);
          return managedRunResult(wait, exit);
        }
        yield* owner.start(wait.id, {
          command: run.command,
          args: run.args,
          cwd: cwd.success,
          env: { ...managedRunEnvironment(), ...run.env },
          logPath: run.logPath,
        });
        return false as const;
      })
    );
  });

const evaluateProgram = (deps: WaitEvaluatorDeps, wait: AutomationWait) => {
  const { ledger, lody, authority, logger, sessionContext } = deps;
  return Effect.tryPromise(() => sessionContext(wait.sessionId, wait.ownerUserId)).pipe(
    Effect.uninterruptible,
    Effect.flatMap((context) =>
      evaluateAutomationProgram(
        wait.program ?? '',
        context,
        (input) =>
          Effect.tryPromise(() =>
            readAutomationContext({
              ledger,
              manager: lody.documentManager,
              authority,
              wait,
              input,
              now: Date.now(),
            })
          ).pipe(Effect.uninterruptible),
        false,
        (input) =>
          Effect.tryPromise({
            try: () => lody.resolveAutomationWorkdir(wait.sessionId as SessionId),
            catch: () => new Error('AUTOMATION_EXEC_WORKSPACE_UNAVAILABLE'),
          }).pipe(
            Effect.flatMap((root) =>
              root
                ? execAutomationCommand(input, root, automationCommandEnvironment()).pipe(
                    Effect.provide(platformLayer({ logger }))
                  )
                : Effect.fail(new Error('AUTOMATION_EXEC_WORKSPACE_UNAVAILABLE'))
            )
          )
      )
    )
  );
};

export function createWaitEvaluator(deps: WaitEvaluatorDeps) {
  const runEvaluator = evaluateRun(deps);
  return (wait: AutomationWait): Effect.Effect<AutomationResult, unknown> =>
    wait.run ? runEvaluator(wait) : evaluateProgram(deps, wait);
}

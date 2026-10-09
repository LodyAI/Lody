import { randomUUID } from 'node:crypto';
import {
  DEFAULT_WORKTREE_CLEANUP_TIMEOUT_MS,
  DEFAULT_WORKTREE_SETUP_TIMEOUT_MS,
  getWorktreeSetupScriptForShell,
  resolveWorktreeSetupShellForPlatform,
  type SessionId,
  type WorktreeCleanupScriptConfig,
  type WorktreeScriptPhase,
  type WorktreeSetupScriptConfig,
  type WorktreeSetupShell,
  type WorkspaceId,
} from '@lody/shared';
import { startProcess } from '@/platform/promise-facade';
import type { TerminationPolicy } from '@lody/shared/node/process';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

const OUTPUT_TAIL_MAX_CHARS = 16_000;
/**
 * How a failed or timed-out script is ended: SIGTERM to the shell's whole
 * process group (every command the script started), then SIGKILL.
 */
const SCRIPT_TERMINATION_POLICY: TerminationPolicy = { graceMs: 2_000, killWaitMs: 2_000 };

export type WorktreeScriptOutputStream = 'stdout' | 'stderr';

export type WorktreeScriptStartEvent = {
  phase: WorktreeScriptPhase;
  shell: WorktreeSetupShell;
  displayCommand: string;
  command: string;
  args: string[];
  workdir: string;
};

export type WorktreeScriptStepStartEvent = {
  phase: WorktreeScriptPhase;
  shell: WorktreeSetupShell;
  stepIndex: number;
  displayCommand: string;
  workdir: string;
};

export type WorktreeScriptOutputEvent = {
  phase: WorktreeScriptPhase;
  stepIndex: number;
  stream: WorktreeScriptOutputStream;
  chunk: string;
};

export type WorktreeScriptStepEndEvent = {
  phase: WorktreeScriptPhase;
  stepIndex: number;
  status: 'completed' | 'failed';
  exitStatus?: {
    exitCode?: number | null;
    signal?: string | null;
  };
};

export type WorktreeScriptEndEvent = {
  phase: WorktreeScriptPhase;
  status: 'completed' | 'failed';
  exitStatus?: {
    exitCode?: number | null;
    signal?: string | null;
  };
  error?: Error;
};

export type WorktreeScriptEvents = {
  onStart?: (event: WorktreeScriptStartEvent) => Promise<void> | void;
  onStepStart?: (event: WorktreeScriptStepStartEvent) => Promise<void> | void;
  onOutput?: (event: WorktreeScriptOutputEvent) => Promise<void> | void;
  onStepEnd?: (event: WorktreeScriptStepEndEvent) => Promise<void> | void;
  onEnd?: (event: WorktreeScriptEndEvent) => Promise<void> | void;
};

export function resolveWorktreeSetupShell(platform = process.platform): WorktreeSetupShell {
  return resolveWorktreeSetupShellForPlatform(platform);
}

function appendOutputTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > OUTPUT_TAIL_MAX_CHARS
    ? next.slice(next.length - OUTPUT_TAIL_MAX_CHARS)
    : next;
}

function getShellSessionCommand(shell: WorktreeSetupShell): { command: string; args: string[] } {
  if (shell === 'powershell') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
    };
  }
  return { command: 'bash', args: ['-l'] };
}

function splitWorktreeScriptLines(script: string): string[] {
  return script
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

type RunningStep = {
  index: number;
  command: string;
  markerPrefix: string;
  markerSuffix: string;
  markerRetainChars: number;
  stdoutBuffer: string;
  stderrBuffer: string;
  stdoutExitCode?: number;
  stderrExitCode?: number;
  stdout: string;
  stderr: string;
  resolve: (exitStatus: { exitCode: number; signal: null }) => void;
  reject: (error: Error) => void;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getStepMarkerRegex(step: RunningStep): RegExp {
  return new RegExp(
    `(?:\\r?\\n)?${escapeRegExp(step.markerPrefix)}(\\d+)${escapeRegExp(step.markerSuffix)}\\r?\\n?`
  );
}

function buildStepInput(shell: WorktreeSetupShell, command: string, step: RunningStep): string {
  if (shell === 'powershell') {
    return [
      command,
      '$__lody_status = if ($?) { 0 } elseif ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 1 }',
      `[Console]::Out.WriteLine("${step.markerPrefix}{0}${step.markerSuffix}", $__lody_status)`,
      `[Console]::Error.WriteLine("${step.markerPrefix}{0}${step.markerSuffix}", $__lody_status)`,
      '',
    ].join('\n');
  }

  return [
    command,
    '__lody_status=$?',
    `printf '\\n${step.markerPrefix}%s${step.markerSuffix}\\n' "$__lody_status"`,
    `printf '\\n${step.markerPrefix}%s${step.markerSuffix}\\n' "$__lody_status" >&2`,
    '',
  ].join('\n');
}

export async function runWorktreeSetup(options: {
  config: WorktreeSetupScriptConfig | null | undefined;
  sessionId: SessionId;
  workspaceId: WorkspaceId;
  workdir: string;
  branch: string;
  repoFullName?: string;
  localProjectId?: string;
  logger: Logger;
  events?: WorktreeScriptEvents;
}): Promise<void> {
  await runWorktreeScript({
    phase: 'setup',
    defaultTimeoutMs: DEFAULT_WORKTREE_SETUP_TIMEOUT_MS,
    ...options,
  });
}

export async function runWorktreeCleanup(options: {
  config: WorktreeCleanupScriptConfig | null | undefined;
  sessionId: SessionId;
  workspaceId: WorkspaceId;
  workdir: string;
  branch: string;
  repoFullName?: string;
  localProjectId?: string;
  logger: Logger;
  events?: WorktreeScriptEvents;
}): Promise<void> {
  await runWorktreeScript({
    phase: 'cleanup',
    defaultTimeoutMs: DEFAULT_WORKTREE_CLEANUP_TIMEOUT_MS,
    ...options,
  });
}

async function runWorktreeScript(options: {
  phase: WorktreeScriptPhase;
  defaultTimeoutMs: number;
  config: WorktreeSetupScriptConfig | WorktreeCleanupScriptConfig | null | undefined;
  sessionId: SessionId;
  workspaceId: WorkspaceId;
  workdir: string;
  branch: string;
  repoFullName?: string;
  localProjectId?: string;
  logger: Logger;
  events?: WorktreeScriptEvents;
}): Promise<void> {
  if (!options.config) {
    return;
  }

  const shell = resolveWorktreeSetupShell();
  const script = getWorktreeSetupScriptForShell(options.config, shell);
  if (!script) {
    return;
  }
  const scriptLines = splitWorktreeScriptLines(script);
  if (scriptLines.length === 0) {
    return;
  }
  const timeoutMs = options.config.timeoutMs ?? options.defaultTimeoutMs;
  const { command, args } = getShellSessionCommand(shell);
  options.logger.info(
    `[${options.sessionId}] Running worktree ${options.phase} (${shell}) in ${options.workdir}`
  );
  await options.events?.onStart?.({
    phase: options.phase,
    shell,
    displayCommand: script,
    command,
    args,
    workdir: options.workdir,
  });

  await new Promise<void>((resolve, reject) => {
    let activeStep: RunningStep | null = null;
    let lastStepExitStatus: WorktreeScriptEndEvent['exitStatus'];
    let settled = false;
    let childClosed = false;
    let childExitStatus: WorktreeScriptEndEvent['exitStatus'];
    let waitForCloseResolve: (() => void) | null = null;
    // The shell leads its own process group so a failure or timeout ends every
    // command the script started, not just the shell.
    const shellProcess = startProcess({
      command,
      args,
      options: {
        cwd: options.workdir,
        env: {
          ...process.env,
          LODY_WORKSPACE_ID: options.workspaceId,
          LODY_SESSION_ID: options.sessionId,
          LODY_WORKTREE_PATH: options.workdir,
          LODY_WORKTREE_BRANCH: options.branch,
          LODY_WORKTREE_SCRIPT_PHASE: options.phase,
          ...(options.repoFullName ? { LODY_GITHUB_REPO: options.repoFullName } : {}),
          ...(options.localProjectId ? { LODY_LOCAL_PROJECT_ID: options.localProjectId } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
      processGroup: true,
    });
    const child = shellProcess.child;

    const emitOutput = (step: RunningStep, stream: WorktreeScriptOutputStream, chunk: string) => {
      if (stream === 'stdout') {
        step.stdout = appendOutputTail(step.stdout, chunk);
      } else {
        step.stderr = appendOutputTail(step.stderr, chunk);
      }
      void Promise.resolve(
        options.events?.onOutput?.({ phase: options.phase, stepIndex: step.index, stream, chunk })
      ).catch((error: unknown) => {
        options.logger.warn(
          `[${options.sessionId}] Failed to record worktree ${options.phase} output: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
    };

    const flushStepBuffers = (step: RunningStep) => {
      if (step.stdoutBuffer) {
        emitOutput(step, 'stdout', step.stdoutBuffer);
        step.stdoutBuffer = '';
      }
      if (step.stderrBuffer) {
        emitOutput(step, 'stderr', step.stderrBuffer);
        step.stderrBuffer = '';
      }
    };

    const maybeResolveStep = (step: RunningStep) => {
      if (step.stdoutExitCode === undefined || step.stderrExitCode === undefined) {
        return;
      }
      flushStepBuffers(step);
      const exitCode = step.stdoutExitCode;
      activeStep = null;
      step.resolve({ exitCode, signal: null });
    };

    const consumeStepStream = (
      step: RunningStep,
      stream: WorktreeScriptOutputStream,
      chunk: string
    ) => {
      const markerSeen = stream === 'stdout' ? step.stdoutExitCode : step.stderrExitCode;
      if (markerSeen !== undefined) {
        emitOutput(step, stream, chunk);
        return;
      }

      const bufferKey = stream === 'stdout' ? 'stdoutBuffer' : 'stderrBuffer';
      step[bufferKey] += chunk;

      const match = getStepMarkerRegex(step).exec(step[bufferKey]);
      if (match) {
        const outputBeforeMarker = step[bufferKey].slice(0, match.index);
        if (outputBeforeMarker) {
          emitOutput(step, stream, outputBeforeMarker);
        }
        const exitCode = Number(match[1] ?? 1);
        if (stream === 'stdout') {
          step.stdoutExitCode = exitCode;
        } else {
          step.stderrExitCode = exitCode;
        }
        const remaining = step[bufferKey].slice(match.index + match[0].length);
        step[bufferKey] = '';
        if (remaining) {
          emitOutput(step, stream, remaining);
        }
        maybeResolveStep(step);
        return;
      }

      const safeLength = Math.max(0, step[bufferKey].length - step.markerRetainChars);
      if (safeLength === 0) {
        return;
      }
      const output = step[bufferKey].slice(0, safeLength);
      step[bufferKey] = step[bufferKey].slice(safeLength);
      emitOutput(step, stream, output);
    };

    const writeStdin = async (value: string) => {
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed) {
        throw new Error(`Worktree ${options.phase} shell stdin is not writable.`);
      }
      await new Promise<void>((writeResolve, writeReject) => {
        stdin.write(value, (error) => {
          if (error) {
            writeReject(error);
            return;
          }
          writeResolve();
        });
      });
    };

    const waitForChildClose = async () => {
      if (childClosed) {
        return;
      }
      await new Promise<void>((closeResolve) => {
        waitForCloseResolve = closeResolve;
      });
    };

    const runStep = async (
      stepIndex: number,
      stepCommand: string
    ): Promise<{ exitCode: number; signal: null; output: string }> => {
      const markerToken = randomUUID().replace(/-/g, '');
      const markerPrefix = `__LODY_WORKTREE_STEP_DONE_${markerToken}_${stepIndex}:`;
      const markerSuffix = '__';
      const step: RunningStep = {
        index: stepIndex,
        command: stepCommand,
        markerPrefix,
        markerSuffix,
        markerRetainChars: markerPrefix.length + markerSuffix.length + 24,
        stdoutBuffer: '',
        stderrBuffer: '',
        stdout: '',
        stderr: '',
        resolve: () => {},
        reject: () => {},
      };

      activeStep = step;
      await options.events?.onStepStart?.({
        phase: options.phase,
        shell,
        stepIndex,
        displayCommand: stepCommand,
        workdir: options.workdir,
      });

      const exitStatus = await new Promise<{ exitCode: number; signal: null }>(
        (stepResolve, stepReject) => {
          step.resolve = stepResolve;
          step.reject = stepReject;
          void writeStdin(buildStepInput(shell, stepCommand, step)).catch(stepReject);
        }
      );

      lastStepExitStatus = exitStatus;
      const status = exitStatus.exitCode === 0 ? 'completed' : 'failed';
      await options.events?.onStepEnd?.({
        phase: options.phase,
        stepIndex,
        status,
        exitStatus,
      });
      return {
        ...exitStatus,
        output: [step.stdout.trim(), step.stderr.trim()].filter(Boolean).join('\n'),
      };
    };

    const settle = (
      status: 'completed' | 'failed',
      error: Error | undefined,
      exitStatus?: WorktreeScriptEndEvent['exitStatus']
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      // A successful script may leave background services running on purpose;
      // a failed one must not leave anything behind, even after its shell exited.
      const terminated = error
        ? shellProcess.terminate(SCRIPT_TERMINATION_POLICY).catch((terminationError: unknown) => {
            options.logger.warn(
              `[${options.sessionId}] Worktree ${options.phase} processes did not exit: ${formatErrorMessage(terminationError)}`
            );
          })
        : Promise.resolve();
      void terminated
        .then(() =>
          options.events?.onEnd?.({
            phase: options.phase,
            status,
            exitStatus,
            error,
          })
        )
        .then(() => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        })
        .catch((historyError: unknown) => {
          const normalizedError =
            historyError instanceof Error ? historyError : new Error(String(historyError));
          if (error) {
            options.logger.warn(
              `[${options.sessionId}] Failed to record worktree ${options.phase} completion: ${normalizedError.message}`
            );
            reject(error);
            return;
          }
          reject(normalizedError);
        });
    };

    const timeout = setTimeout(() => {
      const error = new Error(`Worktree ${options.phase} timed out after ${timeoutMs}ms.`);
      if (activeStep) {
        flushStepBuffers(activeStep);
        void Promise.resolve(
          options.events?.onStepEnd?.({
            phase: options.phase,
            stepIndex: activeStep.index,
            status: 'failed',
            exitStatus: { signal: 'SIGTERM' },
          })
        ).catch(() => {});
        activeStep.reject(error);
      }
      settle('failed', error, { signal: 'SIGTERM' });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (!activeStep) {
        return;
      }
      consumeStepStream(activeStep, 'stdout', text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (!activeStep) {
        return;
      }
      consumeStepStream(activeStep, 'stderr', text);
    });
    child.on('error', (error) => {
      settle('failed', error);
    });
    child.on('close', (code, signal) => {
      childClosed = true;
      childExitStatus = { exitCode: code, signal };
      if (waitForCloseResolve) {
        waitForCloseResolve();
        waitForCloseResolve = null;
        return;
      }
      if (activeStep) {
        flushStepBuffers(activeStep);
        const error = new Error(
          `Worktree ${options.phase} shell exited before command completed: ${activeStep.command}`
        );
        void Promise.resolve(
          options.events?.onStepEnd?.({
            phase: options.phase,
            stepIndex: activeStep.index,
            status: 'failed',
            exitStatus: childExitStatus,
          })
        ).catch(() => {});
        activeStep.reject(error);
        activeStep = null;
      }
    });

    void (async () => {
      for (const [stepIndex, stepCommand] of scriptLines.entries()) {
        const exitStatus = await runStep(stepIndex, stepCommand);
        if (exitStatus.exitCode !== 0) {
          const error = new Error(
            exitStatus.output
              ? `Worktree ${options.phase} failed at command "${stepCommand}" with exit code ${exitStatus.exitCode}:\n${exitStatus.output}`
              : `Worktree ${options.phase} failed at command "${stepCommand}" with exit code ${exitStatus.exitCode}.`
          );
          settle('failed', error, { exitCode: exitStatus.exitCode, signal: null });
          return;
        }
      }
      if (!child.stdin || child.stdin.destroyed) {
        settle('failed', new Error(`Worktree ${options.phase} shell stdin is not writable.`));
        return;
      }
      child.stdin.end('exit\n');
      await waitForChildClose();
      if (childExitStatus?.exitCode === 0) {
        settle('completed', undefined, childExitStatus ?? lastStepExitStatus);
        return;
      }
      const code = childExitStatus?.exitCode ?? null;
      settle(
        'failed',
        new Error(`Worktree ${options.phase} shell failed with exit code ${code}.`),
        childExitStatus
      );
    })().catch((error: unknown) => {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      settle('failed', normalizedError, lastStepExitStatus);
    });
  });
  options.logger.info(`[${options.sessionId}] Worktree ${options.phase} completed`);
}

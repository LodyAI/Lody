export class AcpStartupProcessExitError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrTail: string | null;

  constructor(options: {
    sessionId: string;
    command: string;
    args: string[];
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stderrTail?: string | null;
  }) {
    const exitSummary =
      options.exitCode !== null
        ? `exit code ${options.exitCode}`
        : options.signal
          ? `signal ${options.signal}`
          : 'unknown reason';
    const stderrTail = options.stderrTail?.trim() || null;
    const commandSummary = [options.command, ...options.args].join(' ').trim();
    super(
      `[ACP_STARTUP_FAILED] ACP agent process exited before startup completed (${exitSummary}; command=${commandSummary || options.command})${
        stderrTail ? `; stderr tail: ${stderrTail}` : ''
      }`
    );
    this.name = 'AcpStartupProcessExitError';
    this.exitCode = options.exitCode;
    this.signal = options.signal;
    this.stderrTail = stderrTail;
  }
}

export class AcpStartupProcessError extends Error {
  readonly stderrTail: string | null;

  constructor(options: {
    sessionId: string;
    command: string;
    args: string[];
    stderrTail?: string | null;
    cause: Error;
  }) {
    const stderrTail = options.stderrTail?.trim() || null;
    const commandSummary = [options.command, ...options.args].join(' ').trim();
    super(
      `[ACP_STARTUP_FAILED] ACP agent process failed before startup completed (command=${commandSummary || options.command}): ${options.cause.message}${
        stderrTail ? `; stderr tail: ${stderrTail}` : ''
      }`,
      { cause: options.cause }
    );
    this.name = 'AcpStartupProcessError';
    this.stderrTail = stderrTail;
  }
}

type ProcessExitListener = (exitCode: number | null, signal: NodeJS.Signals | null) => void;
type ProcessErrorListener = (error: Error) => void;

export interface StartupMonitoredProcess {
  onExit(listener: ProcessExitListener): () => void;
  onError(listener: ProcessErrorListener): () => void;
}

export interface AcpStartupMonitor {
  abortPromise: Promise<never>;
  resolveError(error: unknown): unknown;
  dispose(): void;
}

export function appendStderrTail(
  currentTail: string,
  chunk: string,
  maxChars: number = 4000
): string {
  if (!chunk) {
    return currentTail;
  }

  const nextTail = `${currentTail}${chunk}`;
  if (nextTail.length <= maxChars) {
    return nextTail;
  }

  return nextTail.slice(nextTail.length - maxChars);
}

export function createAcpStartupMonitor(
  processHandle: StartupMonitoredProcess,
  options: {
    sessionId: string;
    command: string;
    args: string[];
    getStderrTail?: () => string;
  }
): AcpStartupMonitor {
  let active = true;
  let processFailure: AcpStartupProcessExitError | AcpStartupProcessError | undefined;
  let unsubscribeExit: (() => void) | null = null;
  let unsubscribeError: (() => void) | null = null;

  const cleanup = () => {
    if (!active) {
      return;
    }
    active = false;
    unsubscribeExit?.();
    unsubscribeError?.();
    unsubscribeExit = null;
    unsubscribeError = null;
  };

  const abortPromise = new Promise<never>((_, reject) => {
    const getStderrTail = () => options.getStderrTail?.().trim() || null;

    unsubscribeExit = processHandle.onExit((exitCode, signal) => {
      if (!active) {
        return;
      }
      cleanup();
      processFailure = new AcpStartupProcessExitError({
        sessionId: options.sessionId,
        command: options.command,
        args: options.args,
        exitCode,
        signal,
        stderrTail: getStderrTail(),
      });
      reject(processFailure);
    });

    unsubscribeError = processHandle.onError((error) => {
      if (!active) {
        return;
      }
      cleanup();
      processFailure = new AcpStartupProcessError({
        sessionId: options.sessionId,
        command: options.command,
        args: options.args,
        stderrTail: getStderrTail(),
        cause: error,
      });
      reject(processFailure);
    });
  });

  return {
    abortPromise,
    resolveError(error) {
      // The ACP reader can reject on stdout EOF before the process exit event.
      // Retain diagnostics already received without waiting for another event or
      // changing protocol/authentication/cancellation errors.
      if (
        !(error instanceof Error) ||
        error.name === 'AbortError' ||
        typeof (error as { code?: unknown }).code === 'number' ||
        isAcpStartupProcessFailure(error) ||
        !isAcpTransportDisconnectMessage(error.message)
      ) {
        return error;
      }
      if (processFailure) return processFailure;
      const stderrTail = options.getStderrTail?.().trim();
      return stderrTail
        ? new AcpStartupProcessError({ ...options, stderrTail, cause: error })
        : error;
    },
    dispose: cleanup,
  };
}

export function isAcpStartupProcessFailure(error: unknown): boolean {
  return error instanceof AcpStartupProcessExitError || error instanceof AcpStartupProcessError;
}

export function isAcpTransportDisconnectMessage(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('connection is disposed') ||
    text.includes('acp connection closed') ||
    text.includes('not ready for writing') ||
    text.includes('processtransport') ||
    (text.includes('process') && text.includes('not ready'))
  );
}

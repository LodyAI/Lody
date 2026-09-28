export type SessionSendExitReason = 'workspace' | 'logout' | 'reload' | 'cache-clear' | 'quit';
type ExitGuard = (reason: SessionSendExitReason) => Promise<boolean>;
let guard: ExitGuard | undefined;

export function registerSessionSendExitGuard(next: ExitGuard): () => void {
  guard = next;
  return () => {
    if (guard === next) guard = undefined;
  };
}

export function requestSessionSendExit(reason: SessionSendExitReason): Promise<boolean> {
  return guard ? guard(reason) : Promise.resolve(true);
}

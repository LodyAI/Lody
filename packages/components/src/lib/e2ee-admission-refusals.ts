import { useSyncExternalStore } from 'react';
import { personalHostFailureCode } from './e2ee-control-failure';

/**
 * The latest failure of an unattended email admission, per workspace and request, so team
 * settings can show that the request needs an explicit approval and why. Recording never
 * changes what the host signs and never schedules another attempt.
 */
let refusals: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();
const key = (workspaceId: string, requestId: string) => `${workspaceId}\n${requestId}`;

/** The original error code: a portable host code, or the desktop `e2ee_*` message. */
export function admissionFailureCode(error: unknown): string {
  const portable = personalHostFailureCode(error);
  if (portable) return portable;
  const message = error instanceof Error ? error.message : '';
  return /^e2ee_[\w-]+$/.test(message) ? message : 'unknown';
}

/** Record (or with `null`, clear) the latest automatic-admission failure of a request. */
export function recordAutomaticAdmission(
  workspaceId: string,
  requestId: string,
  code: string | null
) {
  const id = key(workspaceId, requestId);
  if ((refusals.get(id) ?? null) === code) return;
  const next = new Map(refusals);
  if (code === null) next.delete(id);
  else next.set(id, code);
  refusals = next;
  for (const listener of listeners) listener();
}

/** The latest automatic-admission failure code of a request, if any. */
export function useAutomaticAdmissionRefusal(workspaceId: string, requestId: string) {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => refusals
  );
  return current.get(key(workspaceId, requestId));
}

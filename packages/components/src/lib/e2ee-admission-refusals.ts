import { useSyncExternalStore } from 'react';
import { personalHostFailureCode } from './e2ee-control-failure';

/**
 * The latest refusal of an unattended email admission, per workspace and request, so team
 * settings can show that the request needs an explicit approval and why. Recording never
 * changes what the host signs and never schedules another attempt.
 */
let refusals: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();
const key = (workspaceId: string, requestId: string) => `${workspaceId}\n${requestId}`;
const publish = (next: ReadonlyMap<string, string>) => {
  refusals = next;
  for (const listener of listeners) listener();
};

// Desktop IPC rejections arrive as "Error invoking remote method '<channel>': Error: <code>".
const desktopCode = /^(?:Error invoking remote method '[^']+': Error: )?(e2ee_[\w-]+)$/;
/** The original E2EE error code: a portable host code, a code a client adapter attached,
 * or the desktop `e2ee_*` message (with or without its IPC prefix). */
export function e2eeErrorCode(error: unknown): string | null {
  const portable = personalHostFailureCode(error);
  if (portable) return portable;
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('e2ee_')
  )
    return error.code;
  return error instanceof Error ? (desktopCode.exec(error.message)?.[1] ?? null) : null;
}

/** The host's verified reasons for refusing automatic admission (portable and desktop). */
const automaticRefusals = new Set([
  'invitation-invalid',
  'invitation-endorser-ineligible',
  'invitation-expired',
  'invitation-mismatch',
  'invitation-used',
  'e2ee_member_invitation_invalid',
  'e2ee_member_invitation_endorser_ineligible',
  'e2ee_member_invitation_expired',
  'e2ee_member_invitation_mismatch',
  'e2ee_member_invitation_used',
]);
/** The refusal code when the host declined to admit automatically, else null (offline,
 * authentication and other transient failures are not refusals). */
export function automaticAdmissionRefusal(error: unknown): string | null {
  const code = e2eeErrorCode(error);
  return code && automaticRefusals.has(code) ? code : null;
}

/** Record (or with `null`, clear) the latest automatic-admission refusal of a request. */
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
  publish(next);
}

/** Forget refusals of this workspace's requests that are no longer listed. */
export function keepAutomaticAdmissions(workspaceId: string, requestIds: readonly string[]) {
  const live = new Set(requestIds.map((requestId) => key(workspaceId, requestId)));
  const prefix = key(workspaceId, '');
  const stale = [...refusals.keys()].filter((id) => id.startsWith(prefix) && !live.has(id));
  if (!stale.length) return;
  const next = new Map(refusals);
  for (const id of stale) next.delete(id);
  publish(next);
}

/** The latest automatic-admission refusal code of a request, if any. */
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

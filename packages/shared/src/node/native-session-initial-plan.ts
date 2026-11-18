import { validateSchema } from 'loro-mirror';
import { sessionDocSchema } from '../schema';
import { HistoryWriteError } from '../history-write-schema';
import type { NativeSessionReadView } from './native-session-reader';
import type { NativeSessionInitialState } from './native-session-document';
import type { createNativeHistoryPatchPlan } from './native-history-patch';
export const NATIVE_SESSION_CONTROL_ROOTS = [
  'session',
  'mq',
  'humanInputReceipts',
  'cancelRequest',
  'forkOperation',
  'notification',
  'preview',
  'externalHistoryCursor',
  'acpRuntimeConfig',
] as const;
/** Initialization supplies defaults; it must not replace an existing body or
 * a concurrent queue. The caller commits this beside validated initial history. */
export function planNativeSessionInitialControl(
  view: NativeSessionReadView,
  plan: ReturnType<typeof createNativeHistoryPatchPlan>,
  initial: NativeSessionInitialState,
  sessionId: string
): void {
  for (const root of NATIVE_SESSION_CONTROL_ROOTS) {
    const value = root === 'session' ? { ...initial.session, id: sessionId } : initial[root];
    if (value === undefined) continue;
    if (
      !validateSchema(sessionDocSchema.definition[root], value, { ignoreUnknownProperties: true })
        .valid
    )
      throw new HistoryWriteError([{ path: [root], code: 'invalid_control_write' }]);
    const before = view.valueAt([root]);
    if (before !== undefined) continue;
    plan.control(root, before, value);
  }
}

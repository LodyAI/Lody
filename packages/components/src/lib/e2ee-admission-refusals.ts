import { personalHostFailureCode } from './e2ee-control-failure';

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

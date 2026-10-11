/**
 * Frontend limits and message shapes for the simulator's native controls. The
 * machine validates everything again; these exist so the panel can say what is
 * wrong before a round trip, and so a viewer reply is trusted only when it is
 * exactly the answer that was asked for.
 */

export const IOS_SIMULATOR_TEXT_MAX_LENGTH = 4096;
export const IOS_SIMULATOR_URL_MAX_LENGTH = 2048;

export type IosSimulatorTextProblem = 'empty' | 'too-long';

export function validateIosSimulatorText(text: string): IosSimulatorTextProblem | null {
  if (text.length === 0) return 'empty';
  if (text.length > IOS_SIMULATOR_TEXT_MAX_LENGTH) return 'too-long';
  return null;
}

export type IosSimulatorUrlProblem = 'empty' | 'too-long' | 'invalid' | 'scheme';

/** Schemes that run or read something on the device rather than opening a place. */
const REFUSED_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:']);

/**
 * A URL or deep link: any scheme an app may register (`myapp://…`), plus the
 * web's own, but never one that executes or reads local files.
 */
export function validateIosSimulatorUrl(input: string): IosSimulatorUrlProblem | null {
  const url = input.trim();
  if (url.length === 0) return 'empty';
  if (url.length > IOS_SIMULATOR_URL_MAX_LENGTH) return 'too-long';
  for (let index = 0; index < url.length; index += 1) {
    const code = url.charCodeAt(index);
    if (code <= 32 || code === 127) return 'invalid';
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid';
  }
  if (!/^[a-z][a-z0-9+.-]*:$/i.test(parsed.protocol)) return 'invalid';
  if (REFUSED_SCHEMES.has(parsed.protocol.toLowerCase())) return 'scheme';
  return null;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** `iPhone 16 Pro 2026-09-30 14.05.09.png`: sorts by time, no path characters. */
export function getIosSimulatorScreenshotFileName(deviceName: string, at: Date): string {
  const safeName = deviceName.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Simulator';
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(
    at.getHours()
  )}.${pad(at.getMinutes())}.${pad(at.getSeconds())}`;
  return `${safeName} ${stamp}.png`;
}

// ---------------------------------------------------------------------------
// Screenshot handshake with the viewer page.

export const IOS_SIMULATOR_VIEWER_CAPTURE = 'lody:ios-simulator:capture';
export const IOS_SIMULATOR_VIEWER_CAPTURE_RESULT = 'lody:ios-simulator:capture-result';
export const IOS_SIMULATOR_CAPTURE_MAX_BYTES = 16 * 1024 * 1024;
export const IOS_SIMULATOR_CAPTURE_TIMEOUT_MS = 10_000;

export type IosSimulatorCaptureError = 'unavailable' | 'failed' | 'too-large' | 'timeout';

export type IosSimulatorCaptureResult =
  | { ok: true; bytes: ArrayBuffer }
  | { ok: false; error: IosSimulatorCaptureError };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const isPng = (bytes: ArrayBuffer) => {
  if (bytes.byteLength < PNG_SIGNATURE.length) return false;
  const head = new Uint8Array(bytes, 0, PNG_SIGNATURE.length);
  return PNG_SIGNATURE.every((byte, index) => head[index] === byte);
};

/**
 * The answer to one capture request, or null for any message that is not it.
 * A reply that claims success but is not a bounded PNG is a failure, not data.
 */
export function parseIosSimulatorCaptureResult(
  data: unknown,
  operationId: string,
  requestId: string
): IosSimulatorCaptureResult | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as {
    type?: unknown;
    operationId?: unknown;
    requestId?: unknown;
    mimeType?: unknown;
    data?: unknown;
    error?: unknown;
  };
  if (
    message.type !== IOS_SIMULATOR_VIEWER_CAPTURE_RESULT ||
    message.operationId !== operationId ||
    message.requestId !== requestId
  ) {
    return null;
  }
  if (message.error !== undefined) {
    return {
      ok: false,
      error:
        message.error === 'unavailable' || message.error === 'too-large' ? message.error : 'failed',
    };
  }
  if (message.mimeType !== 'image/png' || !(message.data instanceof ArrayBuffer)) {
    return { ok: false, error: 'failed' };
  }
  if (message.data.byteLength > IOS_SIMULATOR_CAPTURE_MAX_BYTES) {
    return { ok: false, error: 'too-large' };
  }
  if (!isPng(message.data)) return { ok: false, error: 'failed' };
  return { ok: true, bytes: message.data };
}

export const IOS_SIMULATOR_VIEWER_CONTROL = 'lody:ios-simulator:control';
export const IOS_SIMULATOR_CONTROL_TIMEOUT_MS = 15_000;
export type IosSimulatorControlResult =
  | { success: true }
  | { success: false; error: 'unavailable' | 'unsupported' | 'failed' | 'busy' | 'timeout' };

export function parseIosSimulatorControlResult(
  data: unknown,
  operationId: string,
  requestId: string
): IosSimulatorControlResult | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as {
    type?: unknown;
    operationId?: unknown;
    requestId?: unknown;
    success?: unknown;
    error?: unknown;
  };
  if (
    message.type !== `${IOS_SIMULATOR_VIEWER_CONTROL}-result` ||
    message.operationId !== operationId ||
    message.requestId !== requestId
  )
    return null;
  if (message.success === true) return { success: true };
  const error = message.error;
  return {
    success: false,
    error:
      error === 'unavailable' || error === 'unsupported' || error === 'busy' ? error : 'failed',
  };
}

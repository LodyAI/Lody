import { randomBytes, timingSafeEqual } from 'node:crypto';

export const LOCAL_IPC_TOKEN_HEADER = 'x-lody-local-token';
// Each daemon process publishes these together with its endpoints in daemon.json.
const credentials = {
  token: randomBytes(32).toString('hex'),
  pipeSuffix: randomBytes(32).toString('hex'),
};
export function getLocalIpcServerCredentials(): typeof credentials {
  return credentials;
}
export function matchesLocalIpcToken(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string' || !/^[a-f0-9]{64}$/.test(actual)) return false;
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(actual, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
export function makeWindowsLocalPipePath(basename: string, suffix: string): string {
  if (!/^[a-f0-9]{64}$/.test(suffix)) throw new Error('invalid_local_pipe_suffix');
  return `\\\\.\\pipe\\${basename}-${suffix}`;
}

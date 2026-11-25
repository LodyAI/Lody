export const ELECTRON_BOOTSTRAP_ENV = 'LODY_ELECTRON_BOOTSTRAP';
export const ELECTRON_SESSION_TOKEN_ENV = 'LODY_ELECTRON_SESSION_TOKEN';
export const ELECTRON_SESSION_USER_ID_ENV = 'LODY_ELECTRON_SESSION_USER_ID';

const ELECTRON_CREDENTIAL_ENV = [ELECTRON_SESSION_TOKEN_ENV, ELECTRON_SESSION_USER_ID_ENV] as const;

export function consumeElectronBootstrapCredentials(env: NodeJS.ProcessEnv): {
  sessionToken: string | undefined;
  sessionUserId: string | undefined;
} {
  const sessionToken = env[ELECTRON_SESSION_TOKEN_ENV]?.trim();
  const sessionUserId = env[ELECTRON_SESSION_USER_ID_ENV]?.trim();
  for (const key of ELECTRON_CREDENTIAL_ENV) {
    delete env[key];
  }
  return { sessionToken, sessionUserId };
}

export function withoutElectronBootstrapCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  for (const key of ELECTRON_CREDENTIAL_ENV) {
    delete childEnv[key];
  }
  return childEnv;
}

/**
 * Desktop launches the embedded CLI via the Electron binary with
 * `ELECTRON_RUN_AS_NODE=1`. Non-Electron children must not inherit it, while
 * children spawned through `process.execPath` must keep it so packaged macOS
 * Electron Helpers run as Node instead of exiting with code 64.
 */
export function resolveElectronRunAsNodeEnv(
  command: string,
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  const flag = process.env.ELECTRON_RUN_AS_NODE;
  if (flag && command === process.execPath) {
    childEnv.ELECTRON_RUN_AS_NODE = flag;
  } else {
    delete childEnv.ELECTRON_RUN_AS_NODE;
  }
  return childEnv;
}

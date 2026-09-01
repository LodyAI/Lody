/**
 * Shared authentication result/progress shapes. Kept apart from
 * `acp-authentication.ts` so the protocol-level runner can report progress
 * without importing the manager that drives it.
 */
export type AcpAuthenticationProgressEvent =
  | { status: 'starting' }
  | {
      status: 'authorization';
      authorizationUrl: string;
      userCode?: string;
      acceptsAuthorizationCode?: boolean;
      expiresInSeconds?: number;
    }
  | { status: 'output'; stream: 'stdout' | 'stderr'; output: string }
  | { status: 'authenticated' }
  | { status: 'cancelled' }
  | { status: 'error'; error: string };

export type AcpAuthenticationDisposition =
  | 'authenticated'
  | 'cancelled'
  | 'not-running'
  | 'input-accepted'
  | 'method-required';

export type AcpAuthenticationMethodChoice = {
  readonly type: 'agent' | 'env_var' | 'terminal';
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
};

/** Outcomes of cancel / code-submission, which never need a method choice. */
export type AcpAuthenticationControlResult = Exclude<
  AcpAuthenticationResult,
  { disposition: 'method-required' }
>;

export type AcpAuthenticationResult =
  | {
      success: true;
      disposition: Exclude<AcpAuthenticationDisposition, 'method-required'>;
    }
  /** The agent advertises several sign-in methods; the user must pick one. */
  | {
      success: true;
      disposition: 'method-required';
      authMethods: readonly AcpAuthenticationMethodChoice[];
    }
  | { success: false; disposition: 'error'; error: string };

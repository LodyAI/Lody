import { Context, Effect } from 'effect';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type { AcpConfigOptionValue, SessionAcpRuntimeConfigPatch } from '@lody/shared';

export class AcpConfigurationError extends Error {
  readonly _tag = 'AcpConfigurationError';
  constructor(
    readonly field: string,
    readonly reason: 'rejected' | 'unsupported' | 'unconfirmed' | 'unknown',
    options?: ErrorOptions
  ) {
    super(
      `ACP_CONFIG_${reason.toUpperCase()}: Cannot apply configuration field ${field}.`,
      options
    );
  }
}

/** One established connection; adapters retain custody of issued SDK requests. */
export class AcpConfiguration extends Context.Service<
  AcpConfiguration,
  {
    readonly options: readonly SessionConfigOption[];
    readonly read: Effect.Effect<SessionAcpRuntimeConfigPatch, AcpConfigurationError>;
    readonly setMode: (value: string) => Effect.Effect<void, AcpConfigurationError>;
    readonly setModel: (value: string) => Effect.Effect<void, AcpConfigurationError>;
    readonly setOption: (
      id: string,
      value: AcpConfigOptionValue
    ) => Effect.Effect<void, AcpConfigurationError>;
  }
>()('lody/agent/AcpConfiguration') {}

export const configurationRequestError = (field: string, cause: unknown): AcpConfigurationError => {
  if (cause instanceof AcpConfigurationError) return cause;
  // A JSON-RPC refusal proves a response; transport failure does not prove non-application.
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  return new AcpConfigurationError(
    field,
    code === -32601
      ? 'unsupported'
      : typeof code === 'number' && code !== -32603
        ? 'rejected'
        : 'unknown',
    { cause }
  );
};

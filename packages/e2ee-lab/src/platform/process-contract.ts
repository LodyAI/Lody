/** Internal synthetic fixture/IPC DTO; not a public wire, recovery vault or
 * trusted production checkpoint store. The parent owns this channel/selection. */
import { Schema } from 'effect';
import { LabKeyRoundCursors } from './key-round';
const limit = Schema.optional(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100))
);
const requestId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
/** Explicit finite commands; result acknowledgement is always a caller decision. */
export const LabKeyCommand = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal('keys'),
    limit,
    cursors: Schema.optional(LabKeyRoundCursors),
  }),
  Schema.Struct({
    operation: Schema.Literal('key-results'),
    limit,
    cursors: Schema.optional(LabKeyRoundCursors),
  }),
  Schema.Struct({
    operation: Schema.Literal('repair'),
    requestId,
    rejectedDigest: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
  }),
  Schema.Struct({
    operation: Schema.Literal('acknowledge-key-result'),
    resultKind: Schema.Literals(['receive', 'repair', 'delivery']),
    resultId: requestId,
  }),
]);
export type LabKeyCommand = typeof LabKeyCommand.Type;

export interface LabProcessConfiguration {
  readonly syntheticOnly: true;
  readonly device: string;
  readonly targets: Readonly<
    Record<string, { readonly signingKey: string; readonly membership: string }>
  >;
  readonly initialKeyOwner: boolean;
  readonly epochRotation?: boolean;
  readonly privateReplayDirectory?: string;
  readonly replaySourceDirectory?: string;
  readonly baseUrl: string;
  readonly directory: string;
  readonly actor: string;
  readonly mode: 'create' | 'open';
  readonly genesis: string;
  readonly records: readonly string[];
  readonly localPoint?: { readonly head: string; readonly length: number };
  readonly point: { readonly head: string; readonly length: number };
}

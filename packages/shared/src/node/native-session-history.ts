import { nativeDocumentWireValue } from './native-history-patch';
import {
  supportsNativeSessionLiteralValues,
  type NativeSessionSdkCompatibility,
} from './native-session-compatibility';
import { prepareHistoryFieldWrite } from '../history-writer';
import {
  LODY_SESSION_DOC_SCHEMA,
  RepoRpcError,
  type RepoClient,
  type JsonValue,
  type JsonPatch,
  type RoomKey,
} from '@loro-dev/loro-repo-client';

/** Scalar writer operations only. User-status/permission/import keep their domain guards. */
export type NativeHistoryScalarField =
  | 'timestamp'
  | 'role'
  | 'userTurnId'
  | 'acpTurnId'
  | 'startedAt'
  | 'endedAt'
  | 'permissionWaitMs'
  | 'status'
  | 'queuedInput'
  | 'cancellationReason'
  | 'read'
  | 'userId'
  | 'finished'
  | 'sendStatus'
  | 'e2eeIntent';

const projectedRecord = (value: unknown): value is Record<string, JsonValue> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  !(value instanceof Uint8Array);

const missingPath = (error: unknown) =>
  error instanceof RepoRpcError &&
  error.code === 'invalid_patch' &&
  error.detail === 'path not found';

/**
 * Trusted Node owner's HistoryWriter field command. The position is a hint,
 * never authority: every attempt checks the current turn identity and the room
 * CAS. No history snapshot, body hydration, writable replica or raw import.
 */
export function createNativeHistoryScalarWriter(options: {
  readonly client: Pick<RepoClient, 'readDoc' | 'applyDocPatch' | 'transactCas'>;
  readonly namespace: string;
  readonly sessionId: string;
  readonly writer: string;
  readonly compatibility?: NativeSessionSdkCompatibility;
}) {
  const { client, namespace, writer } = options;
  const room: RoomKey = { kind: 'loro_doc', id: `session-${options.sessionId}` };
  return {
    async setFieldAt(input: {
      readonly position: number;
      readonly turnId: string;
      readonly field: NativeHistoryScalarField;
      readonly value: unknown;
    }): Promise<boolean> {
      if (!Number.isSafeInteger(input.position) || input.position < 0)
        throw new Error('Invalid native history position');
      return await client.transactCas(async () => {
        const idPath = ['history', input.position, 'id'] as const;
        let identity;
        try {
          identity = await client.readDoc(namespace, room, idPath);
        } catch (error) {
          if (missingPath(error)) return false;
          throw error;
        }
        if (identity.value !== input.turnId) return false;
        let previous: unknown;
        const fieldPath = ['history', input.position, input.field] as const;
        try {
          const current = await client.readDoc(namespace, room, fieldPath);
          if (current.roomTxId !== identity.roomTxId) throw new RepoRpcError('precondition_failed');
          previous = current.value;
        } catch (error) {
          if (!missingPath(error)) throw error;
          // Missing-path errors contain no watermark in 0.1.0. Recheck the
          // identity watermark so absence cannot cross a concurrent change.
          const current = await client.readDoc(namespace, room, idPath);
          if (current.roomTxId !== identity.roomTxId) throw new RepoRpcError('precondition_failed');
        }
        const prepared = prepareHistoryFieldWrite(input.field, previous, input.value);
        if (!prepared.changed) return true;
        if (
          prepared.value !== undefined &&
          prepared.value !== null &&
          typeof prepared.value !== 'string' &&
          typeof prepared.value !== 'number' &&
          typeof prepared.value !== 'boolean'
        )
          throw new Error('Scalar history field required');
        const applyOptions = {
          writer,
          docSchema: LODY_SESSION_DOC_SCHEMA,
          precondition: { mode: 'cas' as const, expected_room_tx_id: identity.roomTxId },
        };
        try {
          // readDoc projects both primitive strings and legacy LoroText as a
          // string. A splice preserves Text; Strict mode rejects a primitive
          // before committing. Only that precise rejection permits the scalar
          // set fallback, still bound to the same CAS watermark.
          if (typeof previous === 'string' && typeof prepared.value === 'string') {
            try {
              await client.applyDocPatch(
                namespace,
                room,
                [
                  {
                    op: 'str_splice',
                    path: fieldPath,
                    at: 0,
                    del: previous.length,
                    ins: prepared.value,
                  },
                ],
                applyOptions
              );
              return true;
            } catch (error) {
              if (
                !(error instanceof RepoRpcError) ||
                error.code !== 'invalid_patch' ||
                typeof error.detail !== 'string' ||
                !error.detail.includes('cannot str_splice atomic LoroValue::String in Strict mode')
              )
                throw error;
            }
          }
          await client.applyDocPatch(
            namespace,
            room,
            [
              prepared.value === undefined
                ? { op: 'unset', path: fieldPath }
                : {
                    op: 'set',
                    path: fieldPath,
                    value: prepared.value as null | string | number | boolean,
                  },
            ],
            applyOptions
          );
          return true;
        } catch (error) {
          const detail = error instanceof RepoRpcError ? error.detail : undefined;
          const atomicInterior =
            error instanceof RepoRpcError &&
            error.code === 'invalid_patch' &&
            typeof detail === 'string' &&
            [
              'cannot str_splice inside atomic LoroValue in Strict mode',
              'cannot partially mutate inside atomic LoroValue in Strict mode',
              'cannot unset inside atomic LoroValue in Strict mode',
            ].some((reason) => detail.includes(reason));
          if (!atomicInterior) throw error;
          // Read/replace just this legacy inline row under the same room CAS.
          // set_value keeps it literal without changing insertion defaults for
          // a new Map/Text turn authored in the same or next transaction.
          const current = await client.readDoc(namespace, room, ['history', input.position]);
          if (current.roomTxId !== identity.roomTxId) throw new RepoRpcError('precondition_failed');
          if (!projectedRecord(current.value) || current.value.id !== input.turnId) return false;
          const next = { ...current.value };
          if (prepared.value === undefined) delete next[input.field];
          else next[input.field] = prepared.value as null | string | number | boolean;
          await client.applyDocPatch(
            namespace,
            room,
            [
              {
                op: supportsNativeSessionLiteralValues(options.compatibility) ? 'set_value' : 'set',
                path: ['history', input.position],
                value: nativeDocumentWireValue(next, options.compatibility),
              } as unknown as JsonPatch[number],
            ],
            supportsNativeSessionLiteralValues(options.compatibility)
              ? applyOptions
              : {
                  ...applyOptions,
                  docSchema: { ...LODY_SESSION_DOC_SCHEMA, defaultObject: 'value' },
                }
          );
          return true;
        }
      });
    },
  };
}

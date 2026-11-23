import { Data, Effect, Result, Schema } from 'effect';
import { type EpochStagedGroup } from '@lody/e2ee-core';
import { authenticateEpochStagedGroup } from '@lody/e2ee-core/protocol';
import { Bytes } from '@lody/e2ee-core';
import { type ContentScope } from '@lody/e2ee-core/protocol';
import {
  admitDocument,
  authenticateDocument,
  deriveDocumentKey,
  disposeDocumentKey,
  openDocument,
} from '@lody/e2ee-core/protocol';
import { type LedgerView } from '@lody/e2ee-core';
import { extendLedger, hashRecordBytes, requireLedgerContinuation } from '@lody/e2ee-core/protocol';
import { fingerprintOf } from '../pure/fingerprint';
import {
  judgeImport,
  judgeInsiderLeak,
  judgeLeak,
  judgeUnauthorizedContent,
  worstVerdict,
  type JudgeVerdict,
} from '../pure/judge';
import { refStateFromOrg, refWriteExpectation } from '../pure/reference-model';
import type { ContentWriteFact } from './content-trace';
import { makeLabOperations } from './operation-scope';

export class LabAttackObservationError extends Data.TaggedError('LabAttackObservationError')<{
  readonly code: 'budget' | 'context' | 'closed';
}> {}
interface ContentProbe {
  readonly kind: 'wrong-context' | 'unauthorized-writer';
  readonly scope: ContentScope;
  readonly originalScope?: ContentScope;
  readonly frame: Uint8Array;
  readonly principal: Bytes.SigningPublicKey;
  readonly additionalData?: Uint8Array;
}
interface InsiderSample {
  readonly scope: ContentScope;
  readonly frame: Uint8Array;
  readonly additionalData?: Uint8Array;
  /** Required for the retained-key positive control. Later ciphertext leakage
   * is measured by an actual authenticated open, without an honest current key. */
  readonly expectedPlaintext?: Uint8Array;
}
export interface LabAttackProbes {
  readonly control?: {
    readonly record: Uint8Array;
    readonly refresh: () => Effect.Effect<LedgerView, unknown>;
    readonly retained: () => Effect.Effect<LedgerView, unknown>;
  };
  readonly content?: readonly ContentProbe[];
  /** Explicit excluded-insider capability, never an honest current key lookup. */
  readonly insider?: {
    readonly key: Bytes.EpochKey;
    readonly keyEpoch: number;
    readonly samples: readonly InsiderSample[];
    readonly freshnessBypassed: boolean;
  };
}
const Refusal = Schema.Struct({ _tag: Schema.String, code: Schema.String });
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const equal = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;
const sameScope = (a: ContentScope, b: ContentScope) =>
  a.genesis === b.genesis &&
  a.resource === b.resource &&
  a.epoch === b.epoch &&
  a.purpose === b.purpose;

/** Measured observer owned by the private harness. Backend capabilities expose
 * protocol bytes only, never honest identities, keys, plaintext traces or paths.
 * Missing probes remain unavailable; refusal due to transport is not evidence.
 * This does not turn captured originals into deterministic fresh encryption. */
export const makeLabAttackObserver = Effect.fn('Lab.makeAttackObserver')(function* (input: {
  readonly genesis: Bytes.GenesisHash;
  readonly backend: {
    readonly read: () => Effect.Effect<readonly Uint8Array[], unknown>;
    readonly appendControl?: (
      record: Uint8Array
    ) => Effect.Effect<{ readonly status: number }, unknown>;
  };
  readonly ledger: () => Effect.Effect<LedgerView, unknown>;
  readonly trace?: {
    readonly contentWritesFor: (org: string) => Effect.Effect<readonly ContentWriteFact[], unknown>;
  };
  readonly committedGroups?: () => Effect.Effect<
    readonly {
      readonly view: LedgerView;
      readonly record: Uint8Array;
      readonly group: EpochStagedGroup | null;
    }[],
    unknown
  >;
  readonly maxFrames?: number;
  readonly maxBytes?: number;
}) {
  const anchor = yield* Effect.fromResult(Bytes.genesisHash(input.genesis.toBytes()));
  const readBackend = input.backend.read.bind(input.backend),
    append = input.backend.appendControl?.bind(input.backend),
    ledger = input.ledger,
    writes = input.trace?.contentWritesFor.bind(input.trace),
    maxFrames = input.maxFrames ?? 128,
    maxBytes = input.maxBytes ?? 16 * 1024 * 1024,
    org = hex(anchor.toBytes());
  if (
    !Number.isSafeInteger(maxFrames) ||
    maxFrames < 1 ||
    maxFrames > 4096 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 64 * 1024 * 1024
  )
    return yield* new LabAttackObservationError({ code: 'budget' });
  const operations = yield* makeLabOperations();
  let closed = false;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    })
  );
  const capture = (rows: readonly Uint8Array[], scratch: Set<Uint8Array>) => {
    if (!Array.isArray(rows) || rows.length > maxFrames)
      throw new LabAttackObservationError({ code: 'budget' });
    const count = rows.length,
      owned: Uint8Array[] = [];
    let size = 0;
    for (let index = 0; index < count; index++) {
      const row = rows[index];
      if (!(row instanceof Uint8Array) || row.length > maxBytes - size)
        throw new LabAttackObservationError({ code: 'budget' });
      size += row.length;
      const copy = new Uint8Array(row);
      scratch.add(copy);
      owned.push(copy);
    }
    if (rows.length !== count) throw new LabAttackObservationError({ code: 'budget' });
    return { rows: owned, size };
  };
  const currentView = Effect.fnUntraced(function* () {
    const current = yield* ledger();
    yield* Effect.fromResult(requireLedgerContinuation(current, current));
    if (!current.genesis.equals(anchor))
      return yield* new LabAttackObservationError({ code: 'context' });
    return current;
  });
  const observe = Effect.fnUntraced(function* (probes: LabAttackProbes, scratch: Set<Uint8Array>) {
    if (closed) return yield* new LabAttackObservationError({ code: 'closed' });
    // Capture every caller-owned original and callback before the first await.
    const capturedProbes = yield* Effect.try({
      try: () => {
        const controlSource = probes.control,
          record = controlSource?.record;
        if (record !== undefined && (!(record instanceof Uint8Array) || record.length > 8192))
          throw new LabAttackObservationError({ code: 'budget' });
        const controlRecord = record && new Uint8Array(record);
        if (controlRecord) scratch.add(controlRecord);
        const control = controlSource &&
          controlRecord && {
            record: controlRecord,
            refresh: controlSource.refresh,
            retained: controlSource.retained,
          };
        const originals = probes.content ?? [],
          samples = probes.insider?.samples ?? [];
        if (
          !Array.isArray(originals) ||
          !Array.isArray(samples) ||
          originals.length > maxFrames ||
          samples.length > maxFrames ||
          (control?.record.length ?? 0) > 8192
        )
          throw new LabAttackObservationError({ code: 'budget' });
        let copiedBytes = control?.record.length ?? 0;
        const copy = (bytes: Uint8Array) => {
          if (!(bytes instanceof Uint8Array) || bytes.length > maxBytes - copiedBytes)
            throw new LabAttackObservationError({ code: 'budget' });
          copiedBytes += bytes.length;
          const owned = new Uint8Array(bytes);
          scratch.add(owned);
          return owned;
        };
        const content: ContentProbe[] = [],
          ownedSamples: InsiderSample[] = [];
        const contentCount = originals.length,
          sampleCount = samples.length;
        for (let index = 0; index < contentCount; index++) {
          const row = originals[index]!;
          content.push({
            kind: row.kind,
            scope: { ...row.scope },
            originalScope: row.originalScope && { ...row.originalScope },
            frame: copy(row.frame),
            additionalData: row.additionalData && copy(row.additionalData),
            principal: row.principal,
          });
        }
        for (let index = 0; index < sampleCount; index++) {
          const row = samples[index]!;
          ownedSamples.push({
            scope: { ...row.scope },
            frame: copy(row.frame),
            additionalData: row.additionalData && copy(row.additionalData),
            expectedPlaintext: row.expectedPlaintext && copy(row.expectedPlaintext),
          });
        }
        if (originals.length !== contentCount || samples.length !== sampleCount)
          throw new LabAttackObservationError({ code: 'budget' });
        const insider = probes.insider && {
          key: probes.insider.key,
          keyEpoch: probes.insider.keyEpoch,
          freshnessBypassed: probes.insider.freshnessBypassed,
          samples: ownedSamples,
        };
        return { control, content, insider };
      },
      catch: (cause) =>
        cause instanceof LabAttackObservationError
          ? cause
          : new LabAttackObservationError({ code: 'context' }),
    });
    const { control, content, insider } = capturedProbes;
    const current = yield* currentView();
    const properties: { id: string; verdict: JudgeVerdict }[] = [];
    const committedGroupFacts: {
      epoch: number;
      expected: string[];
      actual: string[];
      recordMatches: boolean;
    }[] = [];
    let completeGroups: JudgeVerdict = 'unavailable';
    if (input.committedGroups) {
      const rows = yield* Effect.result(input.committedGroups());
      if (Result.isFailure(rows)) completeGroups = 'harness-error';
      else
        completeGroups = worstVerdict(
          rows.success.map(({ view, record, group }) => {
            const recipients = [...view.inspectState().devices.keys()].sort();
            if (!group) {
              committedGroupFacts.push({
                epoch: view.inspectState().epoch.number,
                expected: recipients,
                actual: [],
                recordMatches: false,
              });
              return 'violation';
            }
            const actual = group.envelopes.map((row) => row.recipient).sort();
            committedGroupFacts.push({
              epoch: view.inspectState().epoch.number,
              expected: recipients,
              actual,
              recordMatches: equal(group.record, record),
            });
            return group.genesis === org &&
              group.epoch === view.inspectState().epoch.number &&
              group.recordHash === hex(hashRecordBytes(record).toBytes()) &&
              Result.isSuccess(authenticateEpochStagedGroup(view, group, true)) &&
              equal(group.record, record) &&
              recipients.length === actual.length &&
              recipients.every((id, index) => id === actual[index]) &&
              group.envelopes.every((row) => row.frame.length > 0)
              ? 'pass'
              : 'violation';
          })
        );
    }
    properties.push({
      id: 'durability.committed-rotation-complete-group',
      verdict: completeGroups,
    });
    const raw = yield* Effect.result(readBackend());
    let backendFrames = 0,
      backendBytes = 0,
      plaintextSamples = 0;
    let leak: JudgeVerdict = 'unavailable';
    if (Result.isFailure(raw)) leak = 'harness-error';
    else {
      const captured = yield* Effect.try({
        try: () => capture(raw.success, scratch),
        catch: (cause) => cause,
      });
      backendFrames = captured.rows.length;
      backendBytes = captured.size;
      if (writes) {
        const facts = yield* Effect.result(writes(org));
        if (Result.isFailure(facts)) leak = 'harness-error';
        else {
          let contains = false;
          for (const fact of facts.success) {
            if (Buffer.byteLength(fact.text, 'utf8') > maxBytes)
              return yield* new LabAttackObservationError({ code: 'budget' });
            const plaintext = new TextEncoder().encode(fact.text);
            scratch.add(plaintext);
            if (fact.genesisHex !== org || plaintext.length < 8) continue;
            if (plaintext.length > maxBytes)
              return yield* new LabAttackObservationError({ code: 'budget' });
            plaintextSamples++;
            for (const bytes of captured.rows)
              if (
                Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(
                  Buffer.from(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength)
                )
              )
                contains = true;
          }
          if (plaintextSamples && backendBytes)
            leak = judgeLeak({ backendContainsPlaintext: contains });
        }
      }
    }
    properties.push({ id: 'confidentiality.backend-plaintext', verdict: leak });
    let controlVerdict: JudgeVerdict = 'unavailable',
      unverifiedAccepted: number | undefined;
    if (control) {
      const invalid = extendLedger(current, [control.record], {
        head: hashRecordBytes(control.record),
        length: current.length + 1,
      });
      if (!append || Result.isSuccess(invalid)) controlVerdict = 'harness-error';
      else {
        const sent = yield* Effect.result(append(control.record));
        if (Result.isFailure(sent) || ![200, 201, 204, 400, 403, 409].includes(sent.success.status))
          controlVerdict = 'harness-error';
        else {
          const refreshed = yield* Effect.result(control.refresh()),
            retained = yield* control.retained();
          yield* Effect.fromResult(requireLedgerContinuation(current, retained));
          if (!retained.genesis.equals(anchor))
            return yield* new LabAttackObservationError({ code: 'context' });
          const refusal = Result.isFailure(refreshed)
            ? Schema.decodeUnknownResult(Refusal)(refreshed.failure)
            : null;
          const correctlyRejected =
            refusal &&
            Result.isSuccess(refusal) &&
            refusal.success._tag === 'LedgerFeedError' &&
            refusal.success.code === 'wrong-parent';
          const sameHistory =
            retained.head.equals(current.head) && retained.length === current.length;
          unverifiedAccepted = 0; // Retained view provenance was actually checked above.
          controlVerdict =
            !sameHistory || (Result.isFailure(refreshed) && !correctlyRejected)
              ? 'harness-error'
              : judgeImport({
                  rejected: Result.isFailure(refreshed),
                  ledgerLength: retained.length,
                  expectedLength: current.length,
                  authenticatedHistory: true,
                });
        }
      }
    }
    properties.push({ id: 'integrity.forged-control', verdict: controlVerdict });
    const measured = {
      'wrong-context': [] as JudgeVerdict[],
      'unauthorized-writer': [] as JudgeVerdict[],
    };
    let wrongContextAccepted: boolean | undefined, acceptedUnauthorized: boolean | undefined;
    for (const row of content) {
      const authentic = authenticateDocument(
        current,
        row.originalScope ?? row.scope,
        row.frame,
        row.additionalData
      );
      if (
        Result.isFailure(authentic) ||
        authentic.success.header.device !== hex(row.principal.toBytes())
      ) {
        measured[row.kind].push('harness-error');
        continue;
      }
      if (
        row.kind === 'wrong-context' &&
        (!row.originalScope ||
          sameScope(row.originalScope, row.scope) ||
          Result.isFailure(
            admitDocument(current, row.originalScope, row.frame, row.principal, row.additionalData)
          ))
      ) {
        measured[row.kind].push('harness-error');
        continue;
      }
      if (
        row.kind === 'unauthorized-writer' &&
        refWriteExpectation(
          refStateFromOrg(org, current.inspectState()),
          hex(row.principal.toBytes()),
          row.scope.genesis,
          row.scope.epoch
        ) !== 'deny'
      ) {
        measured[row.kind].push('harness-error');
        continue;
      }
      const admission = admitDocument(
        current,
        row.scope,
        row.frame,
        row.principal,
        row.additionalData
      );
      const accepted = Result.isSuccess(admission);
      if (row.kind === 'wrong-context')
        wrongContextAccepted = (wrongContextAccepted ?? false) || accepted;
      else acceptedUnauthorized = (acceptedUnauthorized ?? false) || accepted;
      const measuredRefusal =
        Result.isFailure(admission) &&
        admission.failure._tag === 'ContentError' &&
        (row.kind === 'unauthorized-writer'
          ? admission.failure.code === 'unauthorized'
          : ['content-context-mismatch', 'bad-content-signature'].includes(admission.failure.code));
      measured[row.kind].push(
        !accepted && !measuredRefusal
          ? 'harness-error'
          : judgeUnauthorizedContent({ observed: true, acceptedUnauthorizedWriter: accepted })
      );
    }
    properties.push(
      { id: 'integrity.wrong-context', verdict: worstVerdict(measured['wrong-context']) },
      {
        id: 'integrity.unauthorized-writer',
        verdict: worstVerdict(measured['unauthorized-writer']),
      }
    );
    let insiderVerdict: JudgeVerdict = 'unavailable',
      oldKeyOpened = 0,
      laterSamples = 0,
      laterOpened = 0;
    if (insider) {
      let invalid = !Number.isSafeInteger(insider.keyEpoch) || insider.keyEpoch < 0;
      for (const row of insider.samples) {
        if (
          row.scope.genesis !== org ||
          Result.isFailure(authenticateDocument(current, row.scope, row.frame, row.additionalData))
        ) {
          invalid = true;
          continue;
        }
        const result = yield* Effect.acquireUseRelease(
          Effect.fromResult(deriveDocumentKey(row.scope, insider.key)),
          (key) =>
            Effect.sync(() => openDocument(current, row.scope, key, row.frame, row.additionalData)),
          (key) => Effect.sync(() => disposeDocumentKey(key))
        );
        let opened = false,
          matched = false;
        if (Result.isSuccess(result)) {
          opened = true;
          matched =
            row.expectedPlaintext !== undefined &&
            equal(result.success.plaintext, row.expectedPlaintext);
          result.success.plaintext.fill(0);
        } else if (result.failure.code !== 'content-authentication-failed') invalid = true;
        if (row.scope.epoch === insider.keyEpoch) {
          if (opened && matched) oldKeyOpened++;
          else invalid = true;
        } else if (row.scope.epoch > insider.keyEpoch) {
          laterSamples++;
          if (opened) laterOpened++;
        }
      }
      insiderVerdict = worstVerdict([
        invalid || !oldKeyOpened || !laterSamples ? 'harness-error' : 'pass',
        judgeInsiderLeak({
          observed: true,
          leaked: laterOpened > 0,
          freshnessBypassed: insider.freshnessBypassed,
        }),
      ]);
    }
    properties.push({ id: 'confidentiality.insider-post-exclusion', verdict: insiderVerdict });
    if (closed) return yield* new LabAttackObservationError({ code: 'closed' });
    const report = Object.freeze({
      confidentiality: worstVerdict([leak, insiderVerdict]),
      integrity: worstVerdict(
        properties.filter((row) => row.id.startsWith('integrity.')).map((row) => row.verdict)
      ),
      durability: completeGroups,
    });
    return Object.freeze({
      report,
      properties: Object.freeze(properties.map((row) => Object.freeze(row))),
      fingerprint: fingerprintOf(
        { ...report, properties },
        {
          verifiedRecords: current.length,
          unverifiedAccepted,
          wrongContextAccepted,
          acceptedUnauthorized,
        }
      ),
      observations: Object.freeze({
        committedGroupFacts,
        backendFrames,
        backendBytes,
        plaintextSamples,
        oldKeyOpened,
        laterSamples,
        laterOpened,
      }),
    });
  });
  return Object.freeze({
    observe: (probes: LabAttackProbes = {}) =>
      operations.run(
        Effect.acquireUseRelease(
          Effect.sync(() => new Set<Uint8Array>()),
          (scratch) => observe(probes, scratch),
          (scratch) =>
            Effect.sync(() => {
              for (const owned of scratch) owned.fill(0);
            })
        )
      ),
  });
});

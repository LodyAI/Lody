import { appendFileSync } from 'node:fs';
import { openSqliteConnection } from '@lody/e2ee-core/internal';
import { createHash } from 'node:crypto';
// Application entrypoint: one Effect Scope owns the complete synthetic session.
import { Cause, Effect, Exit, Queue, Result, Schema } from 'effect';
import { join, isAbsolute } from 'node:path';
import type { SubmissionResult } from '@lody/e2ee-core/services';
import { decodeRecord } from '@lody/e2ee-core/protocol';
import { StreamsClient } from '@loro-dev/streams-client';
import { commitEpochKey, sealHistoryPacket } from '@lody/e2ee-core/protocol';
import { prepareLedgerRecord, signLedgerRecord } from '@lody/e2ee-core/protocol';
import { LedgerFeedError } from '@lody/e2ee-core';
import { frameLedgerRecord } from '@lody/e2ee-core/protocol';
import { Bytes } from '@lody/e2ee-core';
import { encodeCbor } from '@lody/e2ee-core/protocol';
import { makeLabHttpIdentity } from './http-identity';
import {
  capturePreparedInputs,
  loadActorReplay,
  seedPreparedInputs,
  saveActorReplay,
  type LabPreparedInputs,
  type LabOriginalLocalEdit,
  type LabOriginalRequest,
} from './actor-replay';
import { importDevice } from './device';
import { openLabWorkspaceSession } from './full-session';
import { LabLocalEditReplay } from './content-session';
import { labSyntheticProtector } from './synthetic-protection';
import { LabKeyCommand, type LabProcessConfiguration } from './process-contract';
const ok = Result.getOrThrow;
// Protocol errors carry `code`; service errors carry `reason`.
const FailureIdentity = Schema.Struct({
  _tag: Schema.String,
  code: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});
const StreamRefusal = Schema.Struct({
  code: Schema.Literals(['forbidden', 'unauthorized']),
  status: Schema.Literals([401, 403]),
});
// Do not flatten defects, interruption or multiple causes into an expected refusal.
const projectFailure = (cause: Cause.Cause<unknown>, droppedAck: boolean) => {
  const reason = cause.reasons[0];
  if (cause.reasons.length !== 1 || !reason || !Cause.isFailReason(reason))
    return { tag: 'LabHarnessError', code: 'non-domain-failure' };
  const submission = Schema.decodeUnknownResult(
    Schema.Struct({ _tag: Schema.Literal('LedgerLogError') })
  )(reason.error);
  if (Result.isSuccess(submission))
    return droppedAck
      ? { tag: 'LabTransportFault', code: 'dropped-committed-ack' }
      : { tag: 'LedgerLogError', code: 'failed' };
  const decoded = Schema.decodeUnknownResult(FailureIdentity)(reason.error);
  if (Result.isFailure(decoded))
    return { tag: 'LabHarnessError', code: 'invalid-input-or-untyped-failure' };
  const error = decoded.success,
    code = error.code ?? error.reason;
  if (code === undefined)
    return { tag: 'LabHarnessError', code: 'invalid-input-or-untyped-failure' };
  if (error._tag === 'LedgerFeedError' && code === 'transport') {
    const native = Schema.decodeUnknownResult(Schema.Struct({ cause: StreamRefusal }))(
      reason.error
    );
    if (Result.isSuccess(native)) return { tag: error._tag, code: native.success.cause.code };
  }
  return { tag: error._tag, code };
};
const hash = (value: string) => {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('fixture-hash');
  return new Uint8Array(Buffer.from(value, 'hex'));
};
const program = Effect.scoped(
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Record<string, unknown>>();
    let checkpointSequence = 0;
    const pendingCheckpoints = new Map<
      number,
      {
        resolve: (value: {
          point: { head: string; length: number };
          records: readonly string[];
        }) => void;
        reject: (error: unknown) => void;
      }
    >();
    const listener = (message: unknown) => {
      if (
        message &&
        typeof message === 'object' &&
        'kind' in message &&
        message.kind === 'checkpoint-result' &&
        'requestId' in message
      ) {
        const value = message as unknown as {
          requestId: number;
          point: { head: string; length: number };
          records: readonly string[];
          error?: boolean;
        };
        const pending = pendingCheckpoints.get(value.requestId);
        if (pending) {
          pendingCheckpoints.delete(value.requestId);
          if (value.error) pending.reject(new Error('checkpoint-unavailable'));
          else pending.resolve(value);
        }
        return;
      }
      if (
        message &&
        typeof message === 'object' &&
        !Array.isArray(message) &&
        JSON.stringify(message).length <= 256 * 1024
      )
        Queue.offerUnsafe(queue, message as Record<string, unknown>);
    };
    const disconnected = () => Queue.shutdownUnsafe(queue);
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.on('message', listener);
        process.once('disconnect', disconnected);
      }),
      () =>
        Effect.sync(() => {
          for (const pending of pendingCheckpoints.values())
            pending.reject(new Error('checkpoint-owner-closed'));
          pendingCheckpoints.clear();
          process.off('message', listener);
          process.off('disconnect', disconnected);
        })
    );
    let configuration: LabProcessConfiguration | undefined;
    let requests: LabOriginalRequest[] = [];
    let prepared: LabPreparedInputs = { outbox: [] };
    let localEdits: LabOriginalLocalEdit[] = [];
    let replayExpectedRequests: LabOriginalRequest[] | undefined;
    let replayLocalEdits: LabOriginalLocalEdit[] | undefined;
    let activeIndex: number | undefined;
    let session: Effect.Success<ReturnType<typeof openLabWorkspaceSession>> | undefined;
    let point: { head: Bytes.RecordHash; length: number } | undefined;
    let ending = false;
    let fault: 'none' | 'corrupt-loro' | 'drop-control-ack' | 'control-ack-dropped' = 'none';
    let directory = '',
      actor = '',
      targets: LabProcessConfiguration['targets'] = {};
    let originals: readonly string[] = [];
    let lastRotation:
      | Parameters<
          Effect.Success<ReturnType<typeof openLabWorkspaceSession>>['acknowledgeEpochRotation']
        >[0]
      | undefined;
    let lastResult: SubmissionResult | null = null,
      logicalTime = 0;
    let traceFrames = 0,
      traceBytes = 0,
      cipherChanged = 0,
      ackDropped = 0;
    const nativeFetch: typeof fetch = async (input, init) => {
      let request = new Request(input, init);
      const url = new URL(request.url),
        method = request.method;
      // This finite unknown-outcome control drops the accepted CAS reply and
      // withholds subsequent confirmation until the process is reopened/cleared.
      // Otherwise real P09 can correctly reconcile the lost ACK immediately.
      if (
        fault === 'control-ack-dropped' &&
        ['GET', 'HEAD'].includes(method) &&
        url.pathname.endsWith('/control')
      )
        throw new Error('Lab committed ACK and confirmation withheld');
      const selected =
        url.pathname.includes('/ds/') ||
        url.pathname.endsWith('/key-mailbox') ||
        /staged|epoch-group|epoch-staging/.test(url.pathname);
      let requestBytes = selected ? new Uint8Array(await request.clone().arrayBuffer()) : undefined;
      if (selected && ['POST', 'PUT', 'DELETE'].includes(method)) {
        if (replayExpectedRequests) {
          const expected = replayExpectedRequests.shift();
          if (
            !expected ||
            expected.method !== method ||
            expected.path !== url.pathname + url.search
          )
            throw { _tag: 'LabReplayError', code: 'original-input-mismatch' };
          // Reuse only the recorded encrypted input. Real local editing/import,
          // current-authority sealing, HTTP admission, SDK open and persistence
          // still execute. No recorded reply, cursor or resulting row is injected.
          if (/\/(loro|flock)(?:\/snapshot\/[^/]+)?$/.test(url.pathname)) {
            requestBytes = new Uint8Array(Buffer.from(expected.bodyHex, 'hex'));
            request = new Request(request, { body: requestBytes });
          } else if (expected.bodyHex !== Buffer.from(requestBytes!).toString('hex'))
            throw { _tag: 'LabReplayError', code: 'original-input-mismatch' };
        }
        const captured = capturePreparedInputs(directory, actor);
        const previous = new Map(prepared.outbox.map((row) => [row.slot, row]));
        for (const row of captured.outbox) previous.set(row.slot, row);
        prepared = {
          outbox: [...previous.values()],
          rotation: captured.rotation ?? prepared.rotation,
        };
      }
      const response = await fetch(request);
      if (!selected) return response; // credentials/tokens are never recorded
      const original = new Uint8Array(await response.arrayBuffer()),
        bytes = new Uint8Array(original);
      if (selected && ['POST', 'PUT', 'DELETE'].includes(method)) {
        const headers: Record<string, string> = {};
        for (const [name, value] of request.headers)
          if (!/auth|cookie/i.test(name)) headers[name] = value;
        requests.push({
          method,
          path: url.pathname + url.search,
          headers,
          bodyHex: Buffer.from(requestBytes!).toString('hex'),
        });
      }
      let changed = false,
        dropped = false;
      if (
        fault === 'drop-control-ack' &&
        method === 'POST' &&
        url.pathname.endsWith('/control/append-cas') &&
        response.ok
      ) {
        fault = 'control-ack-dropped';
        ackDropped++;
        dropped = true;
      }
      if (
        fault === 'corrupt-loro' &&
        method === 'GET' &&
        url.pathname.includes('/loro') &&
        response.ok
      ) {
        for (let i = 0; i + 75 < bytes.length; i++)
          if (
            bytes[i] === 76 &&
            bytes[i + 1] === 83 &&
            bytes[i + 2] === 67 &&
            bytes[i + 3] === 69 &&
            bytes[i + 10] === 3
          ) {
            bytes[i + 74] = bytes[i + 74]! ^ 1;
            cipherChanged++;
            changed = true;
            break;
          }
      }
      traceBytes += (requestBytes?.length ?? 0) + original.length + bytes.length;
      if (++traceFrames > 1024 || traceBytes > 16 * 1024 * 1024)
        throw new Error('Lab trace budget');
      appendFileSync(
        join(directory, `${actor}-transport.jsonl`),
        JSON.stringify({
          method,
          path: url.pathname,
          status: response.status,
          requestHex: Buffer.from(requestBytes!).toString('hex'),
          originalHex: Buffer.from(original).toString('hex'),
          deliveredHex: Buffer.from(bytes).toString('hex'),
          changed,
          dropped,
          contentType: response.headers.get('content-type'),
          nextOffset: response.headers.get('stream-next-offset'),
        }) + '\n',
        { mode: 0o600 }
      );
      if (dropped) throw new Error('Lab dropped committed ACK');
      return new Response(
        method === 'HEAD' || [204, 205, 304].includes(response.status) ? null : bytes,
        { status: response.status, headers: response.headers }
      );
    };
    const handle = Effect.fnUntraced(function* (command: Record<string, unknown>) {
      if (
        typeof command.logicalTime !== 'number' ||
        !Number.isSafeInteger(command.logicalTime) ||
        command.logicalTime < 0
      )
        return yield* Effect.fail(new Error('fixture-clock'));
      logicalTime = Math.max(logicalTime, command.logicalTime);
      if (command.operation === 'open') {
        if (session) return yield* Effect.fail(new Error('already-started'));
        const c = command.configuration as LabProcessConfiguration;
        if (
          c.syntheticOnly !== true ||
          !isAbsolute(c.directory) ||
          !/^[a-z][a-z0-9-]{0,63}$/.test(c.actor) ||
          !['create', 'open'].includes(c.mode)
        )
          return yield* Effect.fail(new Error('fixture-configuration'));
        configuration = c;
        directory = c.directory;
        actor = c.actor;
        targets = c.targets;
        originals = c.records;
        const device = yield* importDevice(c.device),
          genesis = ok(Bytes.genesisHash(hash(c.genesis)));
        point = { head: ok(Bytes.recordHash(hash(c.point.head))), length: c.point.length };
        const file = (name: string) => join(c.directory, `${c.actor}-${name}.sqlite`);

        session = yield* openLabWorkspaceSession({
          baseUrl: c.baseUrl,
          genesis,
          signer: device,
          path: file('feed'),
          journalPath: file('journal'),
          mode: c.mode,
          expected:
            c.mode === 'open'
              ? {
                  head: ok(Bytes.recordHash(hash((c.localPoint ?? c.point).head))),
                  length: (c.localPoint ?? c.point).length,
                }
              : undefined,
          checkpoint: () =>
            Effect.tryPromise({
              try: () =>
                new Promise<{
                  point: { head: string; length: number };
                  records: readonly string[];
                }>((resolve, reject) => {
                  const requestId = ++checkpointSequence;
                  pendingCheckpoints.set(requestId, { resolve, reject });
                  if (!process.send) {
                    pendingCheckpoints.delete(requestId);
                    reject(new Error('checkpoint-owner-closed'));
                    return;
                  }
                  process.send({ kind: 'checkpoint-request', requestId }, (error) => {
                    if (error) {
                      pendingCheckpoints.delete(requestId);
                      reject(error);
                    }
                  });
                }),
              catch: (cause) => new LedgerFeedError({ code: 'transport', cause }),
            }).pipe(
              Effect.map((value) => {
                point = {
                  head: ok(Bytes.recordHash(hash(value.point.head))),
                  length: value.point.length,
                };
                originals = value.records;
                return point;
              })
            ),
          fetch: nativeFetch,
          budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
          keys: {
            path: file('receive'),
            mode: c.mode,
            pair: device.encryption,
            keyStore: {
              path: file('keys'),
              mode: c.initialKeyOwner ? 'open' : c.mode,
              protector: labSyntheticProtector,
            },
            repairStore: { path: file('repair'), mode: c.mode },
            sendStore: { path: file('send'), mode: c.mode },
            outboxStore: { path: file('outbox'), mode: c.mode },
            currentPublication: (current) =>
              Effect.sync(() => {
                const epoch = current.inspectState().epoch.number;
                for (const original of originals.slice().reverse()) {
                  const bytes = new Uint8Array(Buffer.from(original, 'hex')),
                    decoded = ok(decodeRecord(bytes));
                  if (
                    (epoch === 0 && decoded.body.type === 'genesis') ||
                    (decoded.body.type === 'ordinary' &&
                      ['publishEpoch', 'removeMemberAndPublishEpoch'].includes(
                        decoded.body.operation.type
                      ) &&
                      'epoch' in decoded.body.operation &&
                      decoded.body.operation.epoch === epoch)
                  )
                    return bytes;
                }
                return null;
              }),
          },
          epochRotation: c.epochRotation
            ? { path: file('rotation'), mode: c.mode, protector: labSyntheticProtector }
            : undefined,
          documents: [
            {
              id: 'loro',
              snapshotUpload: true,
              resource: 'document-A',
              path: file('loro'),
              mode: c.mode,
              streamUrl: `${c.baseUrl}/ds/${c.genesis}/loro`,
            },
            {
              id: 'flock',
              snapshotUpload: true,
              model: 'flock',
              now: () => ++logicalTime,
              resource: 'document-B',
              path: file('flock'),
              mode: c.mode,
              streamUrl: `${c.baseUrl}/ds/${c.genesis}/flock`,
            },
          ],
        }).pipe(
          Effect.provideService(
            LabLocalEditReplay,
            c.privateReplayDirectory || c.replaySourceDirectory
              ? {
                  take: (model, text) => {
                    if (!c.replaySourceDirectory) return undefined;
                    const edit = replayLocalEdits?.shift();
                    if (
                      !edit ||
                      edit.model !== model ||
                      edit.text !== text ||
                      !/^(?:[0-9a-f]{2}){1,16777216}$/.test(edit.deltaHex)
                    )
                      throw { _tag: 'LabReplayError', code: 'missing-local-edit-input' };
                    return new Uint8Array(Buffer.from(edit.deltaHex, 'hex'));
                  },
                  capture: (model, text, delta) => {
                    localEdits.push({ model, text, deltaHex: Buffer.from(delta).toString('hex') });
                    delta.fill(0);
                  },
                }
              : undefined
          )
        );
        return { pid: process.pid };
      }
      if (!session) return yield* Effect.fail(new Error('not-started'));
      if (command.point) {
        const p = command.point as { head: string; length: number };
        point = { head: ok(Bytes.recordHash(hash(p.head))), length: p.length };
      }
      if (Array.isArray(command.records)) originals = command.records as string[];
      const doc = command.document;
      if (
        [
          'create',
          'append',
          'pull',
          'recover',
          'persist',
          'observe',
          'edit-offline',
          'flush-offline',
          'upload-snapshot',
        ].includes(String(command.operation)) &&
        typeof doc !== 'string'
      )
        return yield* Effect.fail(new Error('missing-document'));
      switch (command.operation) {
        case 'keys':
        case 'repair':
        case 'key-results':
        case 'acknowledge-key-result': {
          const key = yield* Effect.fromResult(Schema.decodeUnknownResult(LabKeyCommand)(command));
          switch (key.operation) {
            case 'keys':
              return yield* session.keyRound(key.limit, key.cursors);
            case 'repair':
              return yield* session.enqueueRepair(key.requestId, key.rejectedDigest);
            case 'key-results':
              return {
                receive: yield* session.receiveResults(key.limit),
                repair: yield* session.repairResults(key.limit, key.cursors?.repairResults),
                delivery: yield* session.deliveryResults(key.limit, key.cursors?.deliveryResults),
              };
            case 'acknowledge-key-result':
              yield* key.resultKind === 'repair'
                ? session.acknowledgeRepair(key.resultId)
                : key.resultKind === 'delivery'
                  ? session.acknowledgeDelivery(key.resultId)
                  : session.acknowledgeReceive(key.resultId);
              return null;
          }
        }
        case 'refresh': {
          const value = yield* session.refresh();
          return {
            head: Buffer.from(value.view.head.toBytes()).toString('hex'),
            length: value.view.length,
          };
        }
        case 'resume': {
          lastResult = yield* session.resume();
          return lastResult
            ? {
                outcome: lastResult.outcome,
                recordHex: Buffer.from(lastResult.record).toString('hex'),
              }
            : null;
        }
        case 'revoke':
          lastResult = yield* session.submit({
            _tag: 'RevokeDevice',
            target: ok(Bytes.signingPublicKey(hash(targets[String(command.target)]!.signingKey))),
          });
          return {
            outcome: lastResult.outcome,
            recordHex: Buffer.from(lastResult.record).toString('hex'),
          };
        case 'publish-without-stage': {
          const current = yield* session.refresh(),
            view = current.view,
            state = view.inspectState();
          // Explicit synthetic compromised-manager capability: retain fixture E0,
          // pass the genuine ordinary tag7 verifier, then deliberately skip staging.
          const previous = ok(Bytes.epochKey(new Uint8Array(32).fill(117)));
          if (
            state.epoch.number !== 0 ||
            !ok(commitEpochKey(view.genesis, 0, previous)).equals(state.epoch.keyCommitment)
          )
            return yield* Effect.fail({ _tag: 'LabAttackError', code: 'unsupported-known-key' });
          const raw = crypto.getRandomValues(new Uint8Array(32)),
            key = ok(Bytes.epochKey(raw));
          raw.fill(0);
          const commitment = ok(commitEpochKey(view.genesis, 1, key)),
            packet = ok(
              sealHistoryPacket({
                genesis: view.genesis,
                epoch: 1,
                currentKey: key,
                previousKey: previous,
              })
            );
          const device = yield* importDevice(configuration!.device);
          const body = ok(
            encodeCbor([
              view.head.toBytes(),
              device.publicKey.toBytes(),
              [7, 1, commitment.toBytes(), packet],
            ])
          );
          const record = yield* signLedgerRecord(ok(prepareLedgerRecord(view, body)), device);
          const identity = yield* makeLabHttpIdentity({
              baseUrl: configuration!.baseUrl,
              genesis: view.genesis,
              fetch: nativeFetch,
            }),
            auth = yield* identity.authenticate(device);
          const sdk = new StreamsClient({
            url: `${configuration!.baseUrl}/ds/${configuration!.genesis}/control`,
            fetch: auth.fetch,
            retry: { maxAttempts: 1 },
          });
          const result = yield* Effect.uninterruptible(
            Effect.tryPromise({
              try: () =>
                sdk.appendCas({
                  expectedOffset: current.offset,
                  part: {
                    contentType: 'application/octet-stream',
                    body: ok(frameLedgerRecord(record)),
                  },
                }),
              catch: (cause) => cause,
            })
          );
          if (!result.ok || result.result.kind !== 'ok')
            return yield* Effect.fail({ _tag: 'LabAttackError', code: 'cas-refused' });
          yield* session.refresh();
          return {
            outcome: 'Committed',
            epoch: 1,
            recordHex: Buffer.from(record).toString('hex'),
            staged: false,
          };
        }
        case 'set-role': {
          const target = targets[String(command.target)];
          if (!target || !['admin', 'member', 'guest'].includes(String(command.role)))
            return yield* Effect.fail(new Error('invalid-target'));
          lastResult = yield* session.submit({
            _tag: 'SetRole',
            membershipId: ok(
              Bytes.membershipId(new Uint8Array(Buffer.from(target.membership, 'hex')))
            ),
            role: command.role as 'admin' | 'member' | 'guest',
          });
          return {
            outcome: lastResult.outcome,
            recordHex: Buffer.from(lastResult.record).toString('hex'),
          };
        }
        case 'rotate-epoch':
        case 'remove-member-and-rotate':
        case 'resume-epoch-rotation': {
          const target = targets[String(command.target)];
          if (command.operation === 'remove-member-and-rotate' && !target)
            return yield* Effect.fail(new Error('invalid-target'));
          lastRotation =
            (yield* command.operation === 'rotate-epoch'
              ? session.rotateEpoch()
              : command.operation === 'resume-epoch-rotation'
                ? session.resumeEpochRotation()
                : session.removeMemberAndRotate(
                    ok(Bytes.membershipId(new Uint8Array(Buffer.from(target!.membership, 'hex'))))
                  )) ?? undefined;
          return lastRotation
            ? {
                outcome: lastRotation.outcome,
                epoch: lastRotation.epoch,
                recordHex: Buffer.from(lastRotation.record).toString('hex'),
              }
            : null;
        }
        case 'acknowledge-epoch-rotation':
          if (!lastRotation) return yield* Effect.fail(new Error('missing-original-result'));
          yield* session.acknowledgeEpochRotation(lastRotation);
          lastRotation = undefined;
          return null;
        case 'acknowledge':
          if (!lastResult) return yield* Effect.fail(new Error('missing-original-result'));
          yield* session.acknowledge(lastResult);
          lastResult = null;
          return null;
        case 'create':
          yield* session.createDocument(doc as string);
          return null;
        case 'append':
          if (typeof command.text !== 'string' || command.text.length > 4096)
            return yield* Effect.fail(new Error('invalid-text'));
          yield* session.append(doc as string, command.text);
          return null;
        case 'pull':
          yield* session.pull(doc as string);
          return null;
        case 'edit-offline':
          if (typeof command.text !== 'string' || command.text.length > 4096)
            return yield* Effect.fail(new Error('invalid-text'));
          yield* session.editOffline(doc as string, command.text);
          return null;
        case 'flush-offline':
          yield* session.flushOffline(doc as string);
          return null;
        case 'recover':
          yield* session.recoverDocument(doc as string);
          return null;
        case 'upload-snapshot':
          return yield* session.uploadSnapshot(doc as string);
        case 'persist':
          yield* session.persist(doc as string);
          return null;
        case 'observe': {
          const status = yield* session.documentStatus(doc as string);
          const persisted = yield* Effect.acquireUseRelease(
            Effect.sync(() =>
              openSqliteConnection(join(directory, `${actor}-${doc}.sqlite`), {
                readonly: true,
                fileMustExist: true,
              })
            ),
            (db) =>
              Effect.sync(() => {
                const row = db
                  .prepare('SELECT document,cursor FROM lab_document_state WHERE id=1')
                  .get() as { document: Uint8Array; cursor: string | null } | undefined;
                return row
                  ? {
                      documentDigest: createHash('sha256').update(row.document).digest('hex'),
                      cursorDigest:
                        row.cursor === null
                          ? null
                          : createHash('sha256').update(row.cursor).digest('hex'),
                    }
                  : null;
              }),
            (db) => Effect.sync(() => db.close())
          );
          return {
            text: status === 'active' ? yield* session.text(doc as string) : undefined,
            cursor: yield* session.cursor(doc as string),
            status,
            persisted,
          };
        }
        case 'attack': {
          switch (doc) {
            case 'clear':
              fault = 'none';
              return null;
            case 'corrupt-loro':
              fault = 'corrupt-loro';
              return null;
            case 'drop-control-ack':
              fault = 'drop-control-ack';
              return null;
            case 'deny-loro-persist':
            case 'restore-loro-persist':
              yield* Effect.acquireUseRelease(
                Effect.sync(() =>
                  openSqliteConnection(join(directory, `${actor}-loro.sqlite`), {
                    fileMustExist: true,
                  })
                ),
                (db) =>
                  Effect.sync(() =>
                    db.exec(
                      doc === 'deny-loro-persist'
                        ? `CREATE TRIGGER lab_deny_insert BEFORE INSERT ON lab_document_state BEGIN SELECT RAISE(ABORT, 'Lab synthetic storage fault'); END; CREATE TRIGGER lab_deny_update BEFORE UPDATE ON lab_document_state BEGIN SELECT RAISE(ABORT, 'Lab synthetic storage fault'); END`
                        : 'DROP TRIGGER IF EXISTS lab_deny_insert; DROP TRIGGER IF EXISTS lab_deny_update'
                    )
                  ),
                (db) => Effect.sync(() => db.close())
              );
              return null;
            default:
              return yield* Effect.fail(new Error('unsupported-attack'));
          }
        }
        case 'close':
          yield* session.close();
          ending = true;
          return null;
        default:
          return yield* Effect.fail(new Error('unsupported-action'));
      }
    });
    const replay = Effect.fnUntraced(function* (command: Record<string, unknown>) {
      const config = configuration!,
        row = loadActorReplay(
          config.replaySourceDirectory!,
          actor,
          Number(command.materialIndex),
          String(command.operation)
        );
      replayExpectedRequests = [...row.requests];
      replayLocalEdits = [...row.localEdits];
      yield* Effect.sync(() => seedPreparedInputs(directory, actor, row.prepared));
      if (['revoke', 'set-role', 'publish-without-stage'].includes(String(command.operation))) {
        const request = row.requests.find((item) => item.path.endsWith('/control/append-cas'));
        if (!request) return yield* handle(command);
        const framed = new Uint8Array(Buffer.from(request.bodyHex, 'hex'));
        lastResult = yield* session!.submitOriginal(new Uint8Array(framed.subarray(4)));
        if (command.operation === 'publish-without-stage') {
          const current = yield* session!.refresh();
          return {
            outcome: lastResult.outcome,
            epoch: current.view.inspectState().epoch.number,
            recordHex: Buffer.from(lastResult.record).toString('hex'),
            staged: false,
          };
        }
        return {
          outcome: lastResult.outcome,
          recordHex: Buffer.from(lastResult.record).toString('hex'),
        };
      }
      // All document operations consume the original local delta/crypto input
      // through the same live SDK owner and return freshly measured outcomes.
      return yield* handle(command);
    });
    while (true) {
      const command = yield* Queue.take(queue);
      const droppedBefore = ackDropped;
      activeIndex = typeof command.materialIndex === 'number' ? command.materialIndex : undefined;
      requests = [];
      prepared = { outbox: [] };
      localEdits = [];
      replayExpectedRequests = undefined;
      replayLocalEdits = undefined;
      const materialOperation = [
        'keys',
        'append',
        'edit-offline',
        'flush-offline',
        'revoke',
        'set-role',
        'rotate-epoch',
        'remove-member-and-rotate',
        'resume-epoch-rotation',
        'acknowledge-epoch-rotation',
        'publish-without-stage',
        'upload-snapshot',
      ].includes(String(command.operation));
      let result = yield* Effect.exit(
        configuration?.replaySourceDirectory && materialOperation
          ? replay(command)
          : handle(command)
      );
      const pendingOriginals = () =>
        (replayExpectedRequests?.length ?? 0) + (replayLocalEdits?.length ?? 0);
      if (result._tag === 'Success' && pendingOriginals())
        result = Exit.fail({ _tag: 'LabReplayError', code: 'missing-original-request' });
      const known = session && !ending ? yield* Effect.result(session.current()) : undefined;
      const localPoint =
        known && Result.isSuccess(known)
          ? {
              head: Buffer.from(known.success.view.head.toBytes()).toString('hex'),
              length: known.success.view.length,
            }
          : undefined;
      const response =
        result._tag === 'Success'
          ? {
              id: command.id,
              ok: true,
              value: result.value,
              localPoint,
              trace: { frames: traceFrames, cipherChanged, ackDropped },
            }
          : {
              id: command.id,
              ok: false,
              localPoint,
              trace: { frames: traceFrames, cipherChanged, ackDropped },
              error: projectFailure(result.cause, ackDropped > droppedBefore),
            };
      if (configuration?.privateReplayDirectory && activeIndex !== undefined)
        yield* Effect.sync(() =>
          saveActorReplay({
            privateDirectory: configuration!.privateReplayDirectory!,
            actor,
            row: {
              index: activeIndex!,
              operation: String(command.operation),
              requests,
              prepared,
              localEdits,
            },
          })
        );
      yield* Effect.uninterruptible(
        Effect.callback<void, Error>((resume) => {
          if (!process.send) return resume(Effect.fail(new Error('ipc-closed')));
          process.send(response, (error) => resume(error ? Effect.fail(error) : Effect.void));
        })
      );
      if (ending) break;
    }
  })
);
const lifecycle = new AbortController();
process.once('disconnect', () => lifecycle.abort());
const exit = await Effect.runPromiseExit(program, { signal: lifecycle.signal });
if (exit._tag === 'Failure') process.exitCode = 1;
if (process.connected) process.disconnect();

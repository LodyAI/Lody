import { Result } from 'effect';
import { ValidationError } from './errors';
import { epochNumber } from './bytes';
import {
  isHash,
  isBytes,
  validContext,
  validSlot,
  slotId,
  type InstallationContext,
  type MailboxSlot,
  type MailboxDocument,
} from './key-mailbox';
export interface DistributionTask extends MailboxSlot {
  readonly id: string;
  readonly revision: number;
  readonly phase: 'pending' | 'done';
}
export interface ReceiveTask {
  readonly id: string;
  readonly context: InstallationContext;
  readonly frame: string | null;
  readonly publication: string | null;
  readonly report: string | null;
  readonly phase: 'verify' | 'install' | 'report' | 'done';
}
export interface RepairTask extends MailboxSlot {
  readonly id: string;
  readonly rejectedDigest: string | null;
  readonly phase: 'pending' | 'done';
}
export interface DistributionResult {
  readonly id: string;
  readonly taskId: string;
  readonly outcome:
    | 'Observed'
    | 'Installed'
    | 'Reported'
    | 'Repaired'
    | 'Revoked'
    | 'Obsolete'
    | 'Failed';
  readonly code: string | null;
}
export interface DistributionDocument {
  readonly version: 1;
  readonly binding: { readonly genesis: string; readonly recipient: string } | null;
  readonly tasks: readonly DistributionTask[];
  readonly receives: readonly ReceiveTask[];
  readonly repairs: readonly RepairTask[];
  readonly results: readonly DistributionResult[];
}
export const emptyDistribution = (): DistributionDocument => ({
  version: 1,
  binding: null,
  tasks: [],
  receives: [],
  repairs: [],
  results: [],
});
export const distributionTaskId = (slot: MailboxSlot, revision: number) =>
  `${slotId(slot)}:${revision}`;
export const receiveTaskId = (c: InstallationContext) =>
  `${slotId(c)}:${c.revision}:${c.source._tag === 'Envelope' ? c.source.frameDigest : c.source.recordHash}`;
export function finishTask(
  doc: DistributionDocument,
  kind: 'tasks' | 'receives' | 'repairs',
  id: string,
  outcome: DistributionResult['outcome'],
  code: string | null = null
): DistributionDocument {
  const task = doc[kind].find((t) => t.id === id);
  if (!task || task.phase === 'done') return doc;
  const result: DistributionResult = { id: `${kind}:${id}`, taskId: id, outcome, code };
  return {
    ...doc,
    [kind]: doc[kind].map((t) => (t.id === id ? { ...t, phase: 'done' } : t)),
    results: doc.results.some((r) => r.id === result.id) ? doc.results : [...doc.results, result],
  };
}
export function acknowledgeResult(doc: DistributionDocument, id: string): DistributionDocument {
  return { ...doc, results: doc.results.filter((r) => r.id !== id) };
}
const object = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);
const integer = (x: unknown): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const validText = (x: unknown): x is string =>
  typeof x === 'string' && x.length > 0 && x.length <= 512;
const slot = (x: Record<string, unknown>) =>
  isHash(x.genesis) && isHash(x.recipient) && Result.isSuccess(epochNumber(x.epoch));
const bytesOrNull = (x: unknown) => x === null || isBytes(x);
const rows = (x: unknown, check: (row: Record<string, unknown>) => boolean) =>
  Array.isArray(x) && x.length <= 100000 && x.every((r) => object(r) && check(r));
const unique = (x: readonly { readonly id: string }[]) =>
  new Set(x.map((r) => r.id)).size === x.length;
export function validateDistribution(doc: unknown): doc is DistributionDocument {
  if (!object(doc) || doc.version !== 1) return false;
  if (
    doc.binding !== null &&
    (!object(doc.binding) || !isHash(doc.binding.genesis) || !isHash(doc.binding.recipient))
  )
    return false;
  if (
    !rows(
      doc.tasks,
      (t) =>
        slot(t) &&
        validText(t.id) &&
        integer(t.revision) &&
        ['pending', 'done'].includes(String(t.phase))
    )
  )
    return false;
  if (
    !rows(
      doc.receives,
      (t) =>
        validText(t.id) &&
        object(t.context) &&
        validContext(t.context as unknown as InstallationContext) &&
        bytesOrNull(t.frame) &&
        bytesOrNull(t.publication) &&
        bytesOrNull(t.report) &&
        ['verify', 'install', 'report', 'done'].includes(String(t.phase))
    )
  )
    return false;
  if (
    !rows(
      doc.repairs,
      (t) =>
        slot(t) &&
        validText(t.id) &&
        (t.rejectedDigest === null || isHash(t.rejectedDigest)) &&
        ['pending', 'done'].includes(String(t.phase))
    )
  )
    return false;
  if (
    !rows(
      doc.results,
      (r) =>
        validText(r.id) &&
        validText(r.taskId) &&
        ['Observed', 'Installed', 'Reported', 'Repaired', 'Revoked', 'Obsolete', 'Failed'].includes(
          String(r.outcome)
        ) &&
        (r.code === null || validText(r.code))
    )
  )
    return false;
  const d = doc as unknown as DistributionDocument;
  return (
    unique(d.tasks) &&
    unique(d.receives) &&
    unique(d.repairs) &&
    unique(d.results) &&
    d.tasks.every((t) => validSlot(t) && t.id === distributionTaskId(t, t.revision)) &&
    d.receives.every(
      (t) => t.id === receiveTaskId(t.context) && (t.phase !== 'report' || t.report !== null)
    ) &&
    (d.binding !== null ||
      (!d.tasks.length && !d.receives.length && !d.repairs.length && !d.results.length)) &&
    [...d.tasks, ...d.receives.map((t) => t.context), ...d.repairs].every(
      (t) => t.genesis === d.binding?.genesis
    )
  );
}
export function validateMailbox(doc: unknown): doc is MailboxDocument {
  if (!object(doc) || doc.version !== 1) return false;
  if (
    doc.projection !== null &&
    (!object(doc.projection) ||
      !isHash(doc.projection.genesis) ||
      !isHash(doc.projection.head) ||
      !isHash(doc.projection.commitment) ||
      !integer(doc.projection.length) ||
      Result.isFailure(epochNumber(doc.projection.epoch)) ||
      !Array.isArray(doc.projection.recipients) ||
      !doc.projection.recipients.every(isHash))
  )
    return false;
  if (
    !rows(
      doc.entries,
      (e) =>
        slot(e) &&
        integer(e.revision) &&
        Array.isArray(e.rejected) &&
        e.rejected.every(isHash) &&
        Array.isArray(e.reports) &&
        e.reports.every(isBytes) &&
        (e.reportedRevision === null || integer(e.reportedRevision)) &&
        rows(
          e.repairs,
          (r) => validText(r.requestId) && (r.rejectedDigest === null || isHash(r.rejectedDigest))
        ) &&
        rows(
          e.envelopes,
          (f) => validText(f.id) && isHash(f.sender) && isHash(f.digest) && isBytes(f.frame)
        )
    )
  )
    return false;
  const d = doc as unknown as MailboxDocument;
  return (
    new Set(d.entries.map(slotId)).size === d.entries.length &&
    d.entries.every((e) => e.genesis === d.projection?.genesis)
  );
}
export function decodeDocument<A>(text: string, validate: (value: unknown) => value is A) {
  return Result.gen(function* () {
    if (new TextEncoder().encode(text).byteLength > 16 * 1024 * 1024)
      return yield* Result.fail(new ValidationError({ code: 'oversize' }));
    const data = yield* Result.try({
      try: (): unknown => JSON.parse(text),
      catch: () => new ValidationError({ code: 'canonical' }),
    });
    if (!validate(data)) return yield* Result.fail(new ValidationError({ code: 'canonical' }));
    return data;
  });
}
export function encodeDocument<A>(doc: A, validate: (value: unknown) => value is A) {
  return Result.gen(function* () {
    if (!validate(doc)) return yield* Result.fail(new ValidationError({ code: 'canonical' }));
    const text = yield* Result.try({
      try: () => JSON.stringify(doc),
      catch: () => new ValidationError({ code: 'canonical' }),
    });
    if (new TextEncoder().encode(text).byteLength > 16 * 1024 * 1024)
      return yield* Result.fail(new ValidationError({ code: 'oversize' }));
    return text;
  });
}

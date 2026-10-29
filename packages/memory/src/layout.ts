import { LoroDoc, LoroMap, isContainer } from 'loro-crdt';
import {
  MEMORY_ENTRY_PATH,
  MEMORY_FORMAT_VERSION,
  MemoryIdentitySchema,
  MemoryMutationContextSchema,
  type MemoryIdentity,
  type MemoryMutationContext,
} from './schema';
import type { MemoryResult } from './contracts';

/**
 * Each mutation is its own Loro change, tagged with its change ID, so history can locate the
 * versions before and after it. Loro keeps changes with distinct messages unmerged.
 */
export const MEMORY_CHANGE_MESSAGE_PREFIX = 'lody-memory:';
export function commitMemoryChange(doc: LoroDoc, changeId: string) {
  doc.commit({ message: `${MEMORY_CHANGE_MESSAGE_PREFIX}${changeId}` });
}

/** Borrowed Doc: caller owns persistence, remote imports, subscriptions and disposal. */
export function initializeMemoryDoc(
  doc: LoroDoc,
  identity: MemoryIdentity,
  context: MemoryMutationContext
): MemoryResult<void> {
  const parsedIdentity = MemoryIdentitySchema.safeParse(identity);
  const parsedContext = MemoryMutationContextSchema.safeParse(context);
  if (!parsedIdentity.success || !parsedContext.success)
    return { ok: false, error: { code: 'invalid_input' } };
  // Never turn an existing/deleted-history document into a new memory.
  if (doc.opCount() !== 0 || Object.keys(doc.toJSON()).length !== 0) {
    return { ok: false, error: { code: 'invalid_document' } };
  }
  const meta = doc.getMap('meta');
  meta.set('formatVersion', MEMORY_FORMAT_VERSION);
  const storedIdentity = meta.setContainer('identity', new LoroMap());
  for (const [key, value] of Object.entries(parsedIdentity.data)) storedIdentity.set(key, value);
  const documents = doc.getMap('documents');
  const entry = documents.ensureMergeableMap(MEMORY_ENTRY_PATH);
  entry.set('createdAt', parsedContext.data.recordedAt);
  const body = entry.ensureMergeableText('body');
  const changes = entry.ensureMergeableMap('changes');
  changes.set(parsedContext.data.changeId, {
    kind: 'create',
    recordedAt: parsedContext.data.recordedAt,
    source: parsedContext.data.source,
  });
  commitMemoryChange(doc, parsedContext.data.changeId);
  body.free();
  changes.free();
  entry.free();
  documents.free();
  storedIdentity.free();
  meta.free();
  return { ok: true, value: undefined };
}

/** Check against host-resolved identity. This is validation, never authentication. */
export function inspectMemoryIdentity(
  doc: LoroDoc,
  expected: MemoryIdentity
): MemoryResult<MemoryIdentity> {
  const trusted = MemoryIdentitySchema.safeParse(expected);
  if (!trusted.success) return { ok: false, error: { code: 'invalid_input' } };
  const root = doc.getByPath('meta');
  if (!(root instanceof LoroMap)) {
    if (isContainer(root)) root.free();
    return { ok: false, error: { code: 'invalid_document' } };
  }
  try {
    const formatVersion = root.get('formatVersion');
    if (isContainer(formatVersion)) formatVersion.free();
    if (formatVersion !== MEMORY_FORMAT_VERSION)
      return { ok: false, error: { code: 'unsupported_format' } };
    const identity = root.get('identity');
    if (!(identity instanceof LoroMap)) {
      if (isContainer(identity)) identity.free();
      return { ok: false, error: { code: 'invalid_document' } };
    }
    try {
      const parsed = MemoryIdentitySchema.safeParse(identity.toJSON());
      if (!parsed.success) return { ok: false, error: { code: 'invalid_document' } };
      const matches = (Object.keys(trusted.data) as (keyof MemoryIdentity)[]).every(
        (key) => parsed.data[key] === trusted.data[key]
      );
      return matches
        ? { ok: true, value: parsed.data }
        : { ok: false, error: { code: 'scope_mismatch' } };
    } finally {
      identity.free();
    }
  } finally {
    root.free();
  }
}

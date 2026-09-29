import type { SessionMeta } from './schema';

/** A Lody-owned runtime supersedes the immutable imported source identity. */
export function resolveResumableAcpSessionId(
  meta: SessionMeta | undefined
): SessionMeta['acpSessionId'] {
  const id = meta?.acpSessionId;
  if (!id) return undefined;
  if (!meta?.externalHistory) return id;
  const source = meta.externalHistory.sourceAcpSessionId;
  return source && id !== source ? id : undefined;
}

/** Shared by continuation and native fork; a conflicted snapshot cannot name a source. */
export function resolveSessionAcpTargetId(
  meta: SessionMeta | undefined
): SessionMeta['acpSessionId'] {
  const runtime = resolveResumableAcpSessionId(meta);
  if (runtime || meta?.externalHistory?.status === 'sync_conflict') return runtime;
  return meta?.externalHistory?.sourceAcpSessionId;
}

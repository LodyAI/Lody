import {
  readPluginProposal,
  rememberPluginProposal,
  proposalLedgerDir,
} from './plugin-proposal-decision';
import { z } from 'zod';
import { realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { getServerNow, type SessionId } from '@lody/shared';
import {
  pluginProposalMetaSchema,
  pluginProposalState,
  type PluginProposalCommand,
  type PluginProposalMeta,
} from '@lody/shared/plugins/proposal';
import type { SessionBackend } from '@/session/session-backend';
import { createSessionBackend } from '@/session/session-backend';
import { inspectProposalPackage } from '../plugins/plugin-package';
import type { LoroDocumentManager } from './loro/doc';
import { SYNC_CONFIRMATION_TIMEOUT_MS } from './loro/timeout-utils';
type Scope = Pick<
  PluginProposalMeta,
  'workspaceId' | 'machineId' | 'sessionId' | 'requesterUserId'
>;
export interface PluginProposalLedger {
  read: () => Promise<{ meta: PluginProposalMeta; path: string } | undefined>;
  write: (meta: PluginProposalMeta) => Promise<{ meta: PluginProposalMeta; path: string }>;
}
export async function publishPluginProposal(
  backend: Pick<SessionBackend, 'readTurn' | 'appendHistoryTurn'>,
  scope: Scope,
  command: PluginProposalCommand,
  inspect: () => Promise<PluginProposalMeta['artifact']>,
  now = getServerNow,
  ledger?: PluginProposalLedger
) {
  const id = `plugin-proposal-${command.requestId}`;
  const matches = (meta: PluginProposalMeta) =>
    !Object.entries(scope).some(([k, v]) => meta[k as keyof Scope] !== v) &&
    meta.command.action === command.action &&
    meta.command.packagePath === command.packagePath &&
    meta.command.requestId === command.requestId;
  const persisted = await ledger?.read();
  if (persisted && !matches(persisted.meta)) throw Error('Idempotency key conflict');
  const prior = await backend.readTurn(id);
  if (prior.state === 'ready') {
    const notice = z.object({
      type: z.literal('system_notice'),
      name: z.literal('plugin_proposal'),
      meta: pluginProposalMetaSchema,
    });
    const cards = prior.turn.items?.flatMap((i) => {
      const parsed = notice.safeParse(i);
      return parsed.success ? [parsed.data.meta] : [];
    });
    if (cards?.length !== 1 || prior.turn.role !== 'system')
      throw Error('Idempotency key conflict');
    const meta = cards[0]!;
    if (!matches(meta)) throw Error('Idempotency key conflict');
    if (
      persisted &&
      (persisted.meta.expiresAt !== meta.expiresAt ||
        persisted.meta.artifact.sha256 !== meta.artifact.sha256)
    )
      throw Error('Proposal receipt conflict');
    const state = pluginProposalState(meta, now());
    return {
      status:
        state === 'pending' ? pluginProposalState(meta, now(), (await inspect()).sha256) : state,
      artifact: meta.artifact,
    };
  }
  if (prior.state !== 'missing') throw Error('Proposal history unavailable');
  let meta = persisted?.meta;
  if (!meta) {
    meta = pluginProposalMetaSchema.parse({
      ...scope,
      command,
      artifact: await inspect(),
      status: 'pending',
      expiresAt: now() + 24 * 60 * 60 * 1000,
    });
    meta = (await ledger?.write(meta))?.meta ?? meta;
  }
  const timestamp = now();
  await backend.appendHistoryTurn({
    id,
    role: 'system',
    timestamp: new Date(timestamp).toISOString(),
    items: [{ type: 'system_notice', name: 'plugin_proposal', meta }],
    fileDiff: [],
    finished: true,
  });
  return { status: 'pending', artifact: meta.artifact };
}
const pending = new Map<string, Promise<unknown>>();
export async function proposePlugin(
  manager: LoroDocumentManager,
  scope: Scope,
  command: PluginProposalCommand,
  workdir: string,
  local: boolean
) {
  const key = JSON.stringify([scope.workspaceId, scope.sessionId, command.requestId]);
  const prev = pending.get(key);
  const task = (async () => {
    await prev?.catch(() => {});
    const session = await manager.getOrCreateSessionDoc(scope.sessionId as SessionId);
    if (!local) await manager.syncDocOrThrow(session.roomId, { reason: 'plugin:proposal' });
    const backend = await createSessionBackend(session);
    let verifiedPath: string | undefined;
    const result = await publishPluginProposal(
      backend,
      scope,
      command,
      async () => {
        const root = await realpath(workdir),
          path = await realpath(resolve(root, command.packagePath)),
          rel = relative(root, path);
        if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
          throw Error('Package outside Session worktree');
        verifiedPath = path;
        return inspectProposalPackage(path);
      },
      getServerNow,
      {
        read: () => readPluginProposal(proposalLedgerDir(), scope, command.requestId),
        write: async (meta) => {
          if (!verifiedPath) throw Error('Missing proposal artifact');
          return rememberPluginProposal(proposalLedgerDir(), meta, verifiedPath);
        },
      }
    );
    await manager.repo.flush();
    const opts = { timeoutMs: SYNC_CONFIRMATION_TIMEOUT_MS };
    if (
      !local &&
      (!(await backend.waitUntilSynced(opts)) || !(await session.waitUntilSynced(opts)))
    )
      throw Error('Proposal saved locally; retry with the same requestId');
    return result;
  })();
  pending.set(key, task);
  try {
    return await task;
  } finally {
    if (pending.get(key) === task) pending.delete(key);
  }
}

import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  pluginProposalMetaSchema,
  pluginDecisionParams,
  pluginProposalState,
  type PluginProposalMeta,
} from '@lody/shared/plugins/proposal';
import { inspectProposalPackage } from '../plugins/plugin-package';
const frozen = z.strictObject({ meta: pluginProposalMetaSchema, path: z.string().min(1) });
const prefix = (
  root: string,
  workspace: string,
  machine: string,
  session: string,
  request: string
) =>
  join(
    root,
    createHash('sha256')
      .update(JSON.stringify([workspace, machine, session, request]))
      .digest('hex')
  );
export const proposalLedgerDir = () => join(getLodyDataDir(), 'plugin-proposals-v1');
async function writeOnce(path: string, value: unknown) {
  let fd;
  try {
    fd = await open(path, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try {
    await fd.writeFile(JSON.stringify(value));
    await fd.sync();
  } finally {
    await fd.close();
  }
  const dir = await open(dirname(path), 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
  return true;
}
export async function rememberPluginProposal(root: string, meta: PluginProposalMeta, path: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const key = prefix(
    root,
    meta.workspaceId,
    meta.machineId,
    meta.sessionId,
    meta.command.requestId
  );
  const record = { meta, path };
  if (!(await writeOnce(key, record))) {
    const prior = frozen.parse(JSON.parse(await readFile(key, 'utf8')));
    if (!isDeepStrictEqual(prior, record)) throw Error('Proposal receipt conflict');
  }
}
export async function decidePluginProposal(input: {
  root: string;
  workspaceId: string;
  machineId: string;
  actor: { machineOwner: boolean; userId: string };
  params: z.infer<typeof pluginDecisionParams>;
  readCard: () => Promise<PluginProposalMeta>;
  updateCard: (meta: PluginProposalMeta) => Promise<void>;
  activate: (meta: PluginProposalMeta, path: string) => Promise<unknown>;
  now: () => number;
  signal?: AbortSignal;
}) {
  const { root, workspaceId, machineId, actor, now, signal } = input,
    p = pluginDecisionParams.parse(input.params);
  if (!actor.machineOwner || !actor.userId) throw Error('Owner required');
  signal?.throwIfAborted();
  const key = prefix(root, workspaceId, machineId, p.sessionId, p.requestId),
    { meta, path } = frozen.parse(JSON.parse(await readFile(key, 'utf8')));
  if (
    meta.sessionId !== p.sessionId ||
    meta.workspaceId !== workspaceId ||
    meta.machineId !== machineId ||
    meta.command.requestId !== p.requestId ||
    meta.artifact.sha256 !== p.sha256
  )
    throw Error('Wrong proposal');
  const card = await input.readCard();
  if (!isDeepStrictEqual({ ...card, status: 'pending' }, meta)) throw Error('Review card changed');
  const terminal = z.enum(['approved', 'rejected', 'superseded']);
  const result = async (status: z.infer<typeof terminal>) => {
    await input.updateCard({ ...meta, status });
    return { type: 'plugin/proposal-decision' as const, status };
  };
  try {
    const text = await readFile(key + '.result', 'utf8');
    return await result(terminal.parse(JSON.parse(text)));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (card.status !== 'pending') throw Error('Unverified proposal decision');
  if (now() >= meta.expiresAt)
    return { type: 'plugin/proposal-decision' as const, status: 'expired' as const };
  let status: 'approved' | 'rejected' | 'superseded' =
    p.decision === 'deny' ? 'rejected' : 'approved';
  if (status === 'approved') {
    const current = await inspectProposalPackage(path);
    if (!isDeepStrictEqual(current, meta.artifact)) status = 'superseded';
  }
  signal?.throwIfAborted();
  if (pluginProposalState(meta, now()) === 'expired')
    return { type: 'plugin/proposal-decision' as const, status: 'expired' as const };
  // Claim before any side effect. An interrupted activation is outcome-unknown, never retried.
  if (!(await writeOnce(key + '.claim', { decision: p.decision, by: actor.userId, at: now() })))
    throw Error('Decision already in progress or outcome unknown');
  if (status === 'approved') {
    signal?.throwIfAborted();
    await input.activate(meta, path);
  }
  if (!(await writeOnce(key + '.result', status))) throw Error('Conflicting proposal result');
  return result(status);
}

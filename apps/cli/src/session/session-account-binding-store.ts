import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { AccountProfileIdSchema, type SessionMeta } from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { z } from 'zod';

export type SessionAccountScope = { workspaceId: string; machineId: string; sessionId: string };
export type SessionAccountBinding = Pick<
  SessionMeta,
  | 'accountProfileId'
  | 'acpSessionId'
  | 'accountContinuation'
  | 'accountTransitions'
  | 'accountHandoff'
>;
const bindingSchema = z
  .object({
    accountProfileId: AccountProfileIdSchema,
    acpSessionId: z.string().optional(),
    accountContinuation: z.object({ acpSessionId: z.string() }).nullable().optional(),
    accountHandoff: z
      .object({
        requestId: z.string(),
        sourceAccountProfileId: AccountProfileIdSchema,
        sourceAcpSessionId: z.string().optional(),
        targetAccountProfileId: AccountProfileIdSchema,
      })
      .nullable()
      .optional(),
    accountTransitions: z
      .array(
        z.object({
          requestId: z.string(),
          fromAccountProfileId: AccountProfileIdSchema,
          fromAcpSessionId: z.string().optional(),
          toAccountProfileId: AccountProfileIdSchema,
          toAcpSessionId: z.string(),
          continuation: z.boolean(),
          committedAt: z.number(),
        })
      )
      .optional(),
  })
  .strict();
function bindingPath(scope: SessionAccountScope): string {
  const key = createHash('sha256')
    .update(JSON.stringify([scope.workspaceId, scope.machineId, scope.sessionId]))
    .digest('hex');
  return path.join(getLodyDataDir(), 'session-account-bindings', `${key}.json`);
}
/** Local files are the authority. Synced session metadata is only a display mirror. */
export async function getSessionAccountBinding(
  scope: SessionAccountScope
): Promise<SessionAccountBinding | null> {
  let content: string;
  try {
    content = await readFile(bindingPath(scope), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return bindingSchema.parse(JSON.parse(content)) as SessionAccountBinding;
}
export async function setSessionAccountBinding(
  scope: SessionAccountScope,
  binding: SessionAccountBinding
): Promise<void> {
  const content = bindingSchema.parse(binding);
  const destination = bindingPath(scope);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(content)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    if (process.platform !== 'win32') {
      const directory = await open(path.dirname(destination), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
/** Legacy default sessions retain their native history. Untrusted managed mirrors cannot select credentials. */
export async function resolveSessionAccountMeta(
  scope: SessionAccountScope,
  meta: SessionMeta
): Promise<SessionMeta> {
  const binding = await getSessionAccountBinding(scope);
  if (binding)
    return {
      ...meta,
      accountProfileId: binding.accountProfileId,
      acpSessionId: binding.acpSessionId,
      accountContinuation: binding.accountContinuation,
      accountTransitions: binding.accountTransitions,
      accountHandoff: binding.accountHandoff,
    };
  if (meta.accountProfileId && meta.accountProfileId !== 'system-default')
    throw new Error(
      'The local account binding is unavailable. Restore its local account binding before continuing this session.'
    );
  return {
    ...meta,
    accountProfileId: 'system-default',
    acpSessionId: meta.acpSessionId,
    accountContinuation: null,
    accountTransitions: [],
    accountHandoff: null,
  };
}

export async function clearSessionAccountBinding(scope: SessionAccountScope): Promise<void> {
  await rm(bindingPath(scope), { force: true });
}
export async function updateSessionAccountNativeId(
  scope: SessionAccountScope,
  acpSessionId: SessionMeta['acpSessionId']
): Promise<void> {
  const binding = await getSessionAccountBinding(scope);
  if (binding)
    await setSessionAccountBinding(scope, {
      ...binding,
      acpSessionId,
      accountContinuation:
        binding.accountContinuation && acpSessionId
          ? { acpSessionId }
          : binding.accountContinuation,
    });
}

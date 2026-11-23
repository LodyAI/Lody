import { z } from 'zod';

const Identity = z
  .object({
    accountId: z.string().min(1),
    workspaceId: z.string().min(1),
    genesisHash: z.string().regex(/^[0-9a-f]{64}$/),
    signingPublicKey: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/** Public local identity only. Device credentials and secrets never enter cache names. */
export type E2eeLocalDataIdentity = z.infer<typeof Identity>;
export type E2eeLocalDataScope = E2eeLocalDataIdentity & { windowId: string };
export const parseEncryptedLocalScope = (input: unknown): E2eeLocalDataScope =>
  Identity.extend({ windowId: z.string() }).parse(input);

const fields = (input: E2eeLocalDataIdentity) =>
  Identity.parse({
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    genesisHash: input.genesisHash,
    signingPublicKey: input.signingPublicKey,
  });

export function encryptedLocalInstance(input: E2eeLocalDataIdentity): string {
  const identity = fields(input);
  return `e2ee-v1:${JSON.stringify([identity.accountId, identity.workspaceId, identity.genesisHash, identity.signingPublicKey])}`;
}

export function encryptedLocalNamespace(input: E2eeLocalDataScope): string {
  const { windowId, ...identity } = input;
  return `${encryptedLocalInstance(identity)}:${JSON.stringify(windowId)}`;
}

const locatorKey = (accountId: string, workspaceId: string) =>
  `lody-e2ee-local-instance:${JSON.stringify([accountId, workspaceId])}`;

/** Save before opening persistent content, so a cold native removal has an exact locator. */
export function retainEncryptedLocalIdentity(input: E2eeLocalDataIdentity): void {
  const identity = fields(input);
  localStorage.setItem(
    locatorKey(identity.accountId, identity.workspaceId),
    JSON.stringify(identity)
  );
}

/** Local evidence selects a cache, never grants membership or authorizes a native action. */
export function readEncryptedLocalIdentity(
  accountId: string,
  workspaceId: string
): E2eeLocalDataIdentity | null {
  const stored = localStorage.getItem(locatorKey(accountId, workspaceId));
  if (stored === null) return null;
  const parsed = Identity.safeParse(JSON.parse(stored));
  if (
    !parsed.success ||
    parsed.data.accountId !== accountId ||
    parsed.data.workspaceId !== workspaceId
  )
    throw new Error('e2ee_invalid_local_identity');
  return parsed.data;
}

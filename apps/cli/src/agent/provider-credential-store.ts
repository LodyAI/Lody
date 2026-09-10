import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  getLodyCodexCustomProvider,
  isAllowedCredentialEndpoint,
  LODY_CODEX_API_KEY_ENV,
  type AgentConfigMeta,
  type WorkspaceId,
} from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

const LegacyCredentialRecordSchema = z
  .object({
    v: z.literal(1),
    binding: z.string().min(1),
    apiKey: z.string().min(1),
  })
  .strict();

const CredentialEntrySchema = z
  .object({
    revision: z.string().min(1),
    binding: z.string().min(1),
    apiKey: z.string().min(1),
  })
  .strict();

const CredentialRecordSchema = z.discriminatedUnion('v', [
  LegacyCredentialRecordSchema,
  z
    .object({
      v: z.literal(2),
      entries: z.array(CredentialEntrySchema).max(64),
    })
    .strict(),
]);

type CredentialRecord = z.infer<typeof CredentialRecordSchema>;
type CredentialBoundConfig = Pick<
  AgentConfigMeta,
  'id' | 'cliType' | 'agentType' | 'customAcp' | 'runtimeOverrides' | 'env'
>;

function credentialBinding(config: CredentialBoundConfig): string | null {
  if (!getLodyCodexCustomProvider(config.env)) return null;
  return JSON.stringify({
    cliType: config.cliType,
    agentType: config.agentType,
    customAcp: config.customAcp ?? null,
    runtimeOverrides: config.runtimeOverrides ?? null,
    env: Object.fromEntries(
      Object.entries(config.env)
        .filter(([key]) => key !== LODY_CODEX_API_KEY_ENV)
        .sort(([left], [right]) => left.localeCompare(right))
    ),
  });
}

function recordPath(workspaceId: WorkspaceId, configId: string): string {
  const id = createHash('sha256').update(`${workspaceId}\0${configId}`).digest('hex');
  return path.join(getLodyDataDir(), 'provider-credentials', `${id}.json`);
}

async function readRecord(filePath: string): Promise<CredentialRecord | null> {
  try {
    const parsed = CredentialRecordSchema.safeParse(JSON.parse(await readFile(filePath, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeRecord(filePath: string, record: CredentialRecord): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, filePath);
  if (process.platform !== 'win32') await chmod(filePath, 0o600);
}

export async function storeCodexProviderCredential(
  workspaceId: WorkspaceId,
  config: AgentConfigMeta,
  apiKey: string
): Promise<() => Promise<void>> {
  const provider = getLodyCodexCustomProvider(config.env);
  const binding = credentialBinding(config);
  const normalizedKey = apiKey.trim();
  const revision = provider?.credentialRevision?.trim();
  if (
    !provider ||
    !revision ||
    !binding ||
    !isAllowedCredentialEndpoint(provider.baseUrl) ||
    !normalizedKey
  ) {
    throw new Error('Invalid Codex custom endpoint credential');
  }
  const filePath = recordPath(workspaceId, config.id);
  const previous = await readRecord(filePath);
  const entries =
    previous?.v === 2 ? previous.entries.filter((entry) => entry.revision !== revision) : [];
  if (entries.length >= 64) {
    throw new Error('Too many staged Codex credentials; local cleanup is required');
  }
  entries.push({ revision, binding, apiKey: normalizedKey });
  await writeRecord(filePath, { v: 2, entries });
  return async () => {
    if (previous) await writeRecord(filePath, previous);
    else await rm(filePath, { force: true });
  };
}

export async function hydrateCodexProviderCredential<T extends CredentialBoundConfig>(
  workspaceId: WorkspaceId,
  config: T
): Promise<T> {
  const provider = getLodyCodexCustomProvider(config.env);
  const binding = credentialBinding(config);
  if (!provider || !binding) return config;
  const record = await readRecord(recordPath(workspaceId, config.id));
  const entry =
    record?.v === 1
      ? !provider.credentialRevision && record.binding === binding
        ? record
        : null
      : record?.entries.find(
          (candidate) =>
            candidate.revision === provider.credentialRevision && candidate.binding === binding
        );
  if (!entry) return config;
  return {
    ...config,
    env: { ...config.env, [LODY_CODEX_API_KEY_ENV]: entry.apiKey },
  } as T;
}

export async function clearCodexProviderCredential(
  workspaceId: WorkspaceId,
  configId: string,
  revision?: string
): Promise<void> {
  const filePath = recordPath(workspaceId, configId);
  if (!revision) {
    await rm(filePath, { force: true });
    return;
  }
  const record = await readRecord(filePath);
  if (!record) return;
  if (record.v === 1) {
    await rm(filePath, { force: true });
    return;
  }
  const entries = record.entries.filter((entry) => entry.revision !== revision);
  if (entries.length === 0) await rm(filePath, { force: true });
  else if (entries.length !== record.entries.length) await writeRecord(filePath, { v: 2, entries });
}

export async function retainCodexProviderCredential(
  workspaceId: WorkspaceId,
  configId: string,
  revision: string
): Promise<void> {
  const filePath = recordPath(workspaceId, configId);
  const record = await readRecord(filePath);
  if (!record || record.v !== 2) return;
  const entries = record.entries.filter((entry) => entry.revision === revision);
  if (entries.length === 0) await rm(filePath, { force: true });
  else if (entries.length !== record.entries.length) await writeRecord(filePath, { v: 2, entries });
}

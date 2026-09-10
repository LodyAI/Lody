import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  getLodyCodexCustomProvider,
  getLodyCodexCredentialBinding,
  isAllowedCredentialEndpoint,
  LODY_CODEX_API_KEY_ENV,
  type AgentConfigMeta,
  type WorkspaceId,
} from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

const CredentialEntrySchema = z
  .object({
    binding: z.string().min(1),
    apiKey: z.string().min(1),
  })
  .strict();

const CredentialRecordSchema = z
  .object({
    v: z.literal(1),
    current: CredentialEntrySchema,
    previous: CredentialEntrySchema.optional(),
  })
  .strict();

type CredentialRecord = z.infer<typeof CredentialRecordSchema>;
type CredentialBoundConfig = Pick<
  AgentConfigMeta,
  'id' | 'cliType' | 'agentType' | 'customAcp' | 'runtimeOverrides' | 'env'
>;

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
  try {
    await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    if (process.platform !== 'win32') await chmod(filePath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function getCredentialBindingDigest(config: CredentialBoundConfig): string | null {
  const binding = getLodyCodexCredentialBinding(config);
  return binding ? createHash('sha256').update(binding).digest('hex') : null;
}

export type StagedCodexProviderCredential = {
  finalize: () => Promise<void>;
  rollback: () => Promise<void>;
};

/**
 * Opens the short cross-store commit window after a successful live probe.
 * The desired binding and the currently published binding remain readable
 * until AgentConfig publication chooses which one survives.
 */
export async function stageCodexProviderCredential(
  workspaceId: WorkspaceId,
  desiredConfig: AgentConfigMeta,
  apiKey: string,
  publishedConfig?: AgentConfigMeta
): Promise<StagedCodexProviderCredential> {
  const provider = getLodyCodexCustomProvider(desiredConfig.env);
  const desiredBinding = getCredentialBindingDigest(desiredConfig);
  const normalizedKey = apiKey.trim();
  if (
    !provider ||
    !desiredBinding ||
    !isAllowedCredentialEndpoint(provider.baseUrl) ||
    !normalizedKey
  ) {
    throw new Error('Invalid Codex custom endpoint credential');
  }

  const filePath = recordPath(workspaceId, desiredConfig.id);
  const previousRecord = await readRecord(filePath);
  const publishedBinding = publishedConfig ? getCredentialBindingDigest(publishedConfig) : null;
  const previousEntry = publishedBinding
    ? [previousRecord?.current, previousRecord?.previous].find(
        (entry) => entry?.binding === publishedBinding
      )
    : undefined;
  const stagedRecord: CredentialRecord = {
    v: 1,
    current: { binding: desiredBinding, apiKey: normalizedKey },
    ...(previousEntry && previousEntry.binding !== desiredBinding
      ? { previous: previousEntry }
      : {}),
  };
  await writeRecord(filePath, stagedRecord);

  const recordStillMatches = async (): Promise<boolean> => {
    const current = await readRecord(filePath);
    return (
      current?.current.binding === stagedRecord.current.binding &&
      current.current.apiKey === stagedRecord.current.apiKey
    );
  };
  return {
    finalize: async () => {
      if (!(await recordStillMatches())) return;
      await writeRecord(filePath, { v: 1, current: stagedRecord.current });
    },
    rollback: async () => {
      if (!(await recordStillMatches())) return;
      if (previousRecord) await writeRecord(filePath, previousRecord);
      else await rm(filePath, { force: true });
    },
  };
}

/** Keep only credentials referenced by an authoritative config/setup decision. */
export async function reconcileCodexProviderCredential(
  workspaceId: WorkspaceId,
  configId: string,
  referencedConfigs: AgentConfigMeta[]
): Promise<void> {
  const filePath = recordPath(workspaceId, configId);
  const record = await readRecord(filePath);
  if (!record) return;
  const referencedBindings = referencedConfigs
    .map(getCredentialBindingDigest)
    .filter((binding): binding is string => Boolean(binding));
  const retained = referencedBindings
    .map((binding) => [record.current, record.previous].find((entry) => entry?.binding === binding))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  const [current, previous] = retained.filter(
    (entry, index, entries) =>
      entries.findIndex((other) => other.binding === entry.binding) === index
  );
  if (!current) {
    await rm(filePath, { force: true });
    return;
  }
  await writeRecord(filePath, {
    v: 1,
    current,
    ...(previous ? { previous } : {}),
  });
}

export async function hydrateCodexProviderCredential<T extends CredentialBoundConfig>(
  workspaceId: WorkspaceId,
  config: T
): Promise<T> {
  const binding = getCredentialBindingDigest(config);
  if (!getLodyCodexCustomProvider(config.env) || !binding) return config;
  const record = await readRecord(recordPath(workspaceId, config.id));
  const credential = [record?.current, record?.previous].find(
    (entry) => entry?.binding === binding
  );
  if (!credential) return config;
  return {
    ...config,
    env: { ...config.env, [LODY_CODEX_API_KEY_ENV]: credential.apiKey },
  } as T;
}

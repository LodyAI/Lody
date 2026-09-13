import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { type AgentConfigMeta, type WorkspaceId } from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  resolveProviderCredentialAdapter,
  type ProviderCredentialConfig,
} from './provider-credential-adapter';

const PersistedCredentialEntrySchema = z
  .object({
    binding: z.string().min(1),
    apiKey: z.string().min(1),
  })
  .strict();

const CredentialRecordSchema = z
  .object({
    v: z.literal(2),
    workspaceId: z.string().min(1),
    configId: z.string().min(1),
    current: PersistedCredentialEntrySchema,
    previous: PersistedCredentialEntrySchema.optional(),
  })
  .strict();

type CredentialEntry = { binding: string; secret: string };
type CredentialRecord = {
  v: 2;
  workspaceId: string;
  configId: string;
  current: CredentialEntry;
  previous?: CredentialEntry;
};
function recordPath(workspaceId: WorkspaceId, configId: string): string {
  const id = createHash('sha256').update(`${workspaceId}\0${configId}`).digest('hex');
  return path.join(getLodyDataDir(), 'provider-credentials', `${id}.json`);
}

async function readRecord(filePath: string): Promise<CredentialRecord | null> {
  try {
    const parsed = CredentialRecordSchema.safeParse(JSON.parse(await readFile(filePath, 'utf8')));
    if (!parsed.success) return null;
    return {
      v: 2,
      workspaceId: parsed.data.workspaceId,
      configId: parsed.data.configId,
      current: {
        binding: parsed.data.current.binding,
        secret: parsed.data.current.apiKey,
      },
      ...(parsed.data.previous
        ? {
            previous: {
              binding: parsed.data.previous.binding,
              secret: parsed.data.previous.apiKey,
            },
          }
        : {}),
    };
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
    const persisted = {
      v: 2,
      workspaceId: record.workspaceId,
      configId: record.configId,
      current: { binding: record.current.binding, apiKey: record.current.secret },
      ...(record.previous
        ? {
            previous: {
              binding: record.previous.binding,
              apiKey: record.previous.secret,
            },
          }
        : {}),
    };
    await writeFile(temporaryPath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    if (process.platform !== 'win32') await chmod(filePath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function listProviderCredentialConfigIds(workspaceId: WorkspaceId): Promise<string[]> {
  const directory = path.join(getLodyDataDir(), 'provider-credentials');
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const ids = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        const record = await readRecord(path.join(directory, entry.name));
        return record?.workspaceId === workspaceId ? record.configId : null;
      })
  );
  return [...new Set(ids.filter((id): id is string => id !== null))];
}

export type StagedProviderCredential = {
  finalize: () => Promise<void>;
  rollback: () => Promise<void>;
};

/**
 * Opens the short cross-store commit window after a successful live probe.
 * The desired binding and the currently published binding remain readable
 * until AgentConfig publication chooses which one survives.
 */
export async function stageProviderCredential(
  workspaceId: WorkspaceId,
  desiredConfig: AgentConfigMeta,
  secret: string,
  publishedConfig?: AgentConfigMeta
): Promise<StagedProviderCredential> {
  const desired = resolveProviderCredentialAdapter(desiredConfig);
  if (!desired) throw new Error('Unsupported machine-local provider credential');
  const normalizedSecret = desired.adapter.normalizeSecret(desiredConfig, secret);

  const filePath = recordPath(workspaceId, desiredConfig.id);
  const previousRecord = await readRecord(filePath);
  const publishedBinding = publishedConfig
    ? resolveProviderCredentialAdapter(publishedConfig)?.bindingDigest
    : undefined;
  if (publishedBinding && publishedBinding === desired.bindingDigest) {
    throw new Error('Provider credential rotation requires a fresh credential revision');
  }
  const previousEntry = publishedBinding
    ? [previousRecord?.current, previousRecord?.previous].find(
        (entry) => entry?.binding === publishedBinding
      )
    : undefined;
  const stagedRecord: CredentialRecord = {
    v: 2,
    workspaceId,
    configId: desiredConfig.id,
    current: { binding: desired.bindingDigest, secret: normalizedSecret },
    ...(previousEntry ? { previous: previousEntry } : {}),
  };
  await writeRecord(filePath, stagedRecord);

  const recordStillMatches = async (): Promise<boolean> => {
    const current = await readRecord(filePath);
    return (
      current?.current.binding === stagedRecord.current.binding &&
      current.current.secret === stagedRecord.current.secret
    );
  };
  return {
    finalize: async () => {
      if (!(await recordStillMatches())) return;
      await writeRecord(filePath, {
        v: 2,
        workspaceId,
        configId: desiredConfig.id,
        current: stagedRecord.current,
      });
    },
    rollback: async () => {
      if (!(await recordStillMatches())) return;
      if (previousRecord) await writeRecord(filePath, previousRecord);
      else await rm(filePath, { force: true });
    },
  };
}

/** Keep only credentials referenced by an authoritative config/setup decision. */
export async function reconcileProviderCredential(
  workspaceId: WorkspaceId,
  configId: string,
  referencedConfigs: AgentConfigMeta[]
): Promise<void> {
  const filePath = recordPath(workspaceId, configId);
  const record = await readRecord(filePath);
  if (!record) return;
  const referencedBindings = referencedConfigs
    .map((config) => resolveProviderCredentialAdapter(config)?.bindingDigest)
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
    v: 2,
    workspaceId,
    configId,
    current,
    ...(previous ? { previous } : {}),
  });
}

export async function hydrateProviderCredential<T extends ProviderCredentialConfig>(
  workspaceId: WorkspaceId,
  config: T
): Promise<T> {
  const resolved = resolveProviderCredentialAdapter(config);
  if (!resolved) return config;
  const record = await readRecord(recordPath(workspaceId, config.id));
  const credential = [record?.current, record?.previous].find(
    (entry) => entry?.binding === resolved.bindingDigest
  );
  if (!credential) return config;
  return resolved.adapter.injectSecret(config, credential.secret);
}

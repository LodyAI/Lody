import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { z } from 'zod';

const SorbetProviderPreferencesSchema = z
  .object({
    version: z.literal(1),
    claudeOAuthEnabled: z.boolean().default(false),
    defaultProviderId: z.string().trim().min(1).optional(),
    defaultModelSelector: z.string().trim().min(1).optional(),
  })
  .strict();

export type SorbetProviderPreferences = z.infer<typeof SorbetProviderPreferencesSchema>;

export const getSorbetDataDirectory = (): string => join(getLodyDataDir(), 'agents', 'sorbet');

const getPreferencesPath = (): string =>
  join(getSorbetDataDirectory(), 'lody-provider-center.json');

export async function readSorbetProviderPreferences(): Promise<SorbetProviderPreferences> {
  try {
    const parsed: unknown = JSON.parse(await readFile(getPreferencesPath(), 'utf8'));
    return SorbetProviderPreferencesSchema.parse(parsed);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { version: 1, claudeOAuthEnabled: false };
    }
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return { version: 1, claudeOAuthEnabled: false };
    }
    throw error;
  }
}

export async function writeSorbetProviderPreferences(
  preferences: SorbetProviderPreferences
): Promise<void> {
  const parsed = SorbetProviderPreferencesSchema.parse(preferences);
  const directory = getSorbetDataDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = getPreferencesPath();
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(parsed, undefined, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function getSorbetDefaultModelSelector(): Promise<string | undefined> {
  return (await readSorbetProviderPreferences()).defaultModelSelector;
}

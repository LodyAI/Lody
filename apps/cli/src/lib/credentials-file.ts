import fs from 'node:fs';
import path from 'node:path';
import type { MachineId } from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { z } from 'zod';
import { writePrivateCredentialFile } from './private-credential-file';

const CREDENTIALS_FILE_NAME = 'credentials.json';

export const MachineIdSchema: z.ZodType<MachineId> = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value as MachineId);

export const CredentialsUserSchema = z.object({
  id: z.string().min(1),
  email: z.string(),
  name: z.string().nullable().optional(),
});

export const CredentialsV3Schema = z
  .object({
    version: z.literal(3),
    token: z.string().min(1),
    user: z
      .object({
        id: z.string().min(1),
        email: z.string().optional(),
        name: z.string().nullable().optional(),
      })
      .passthrough(),
    machine: z
      .object({
        machineName: z.string().optional(),
        machineId: MachineIdSchema,
      })
      .passthrough(),
    createdAt: z.string().optional(),
  })
  .passthrough();

export type CredentialsV3 = z.infer<typeof CredentialsV3Schema>;

export interface CredentialsV3Write {
  version: 3;
  token: string;
  user: {
    id: string;
    email?: string;
    name?: string | null;
  };
  machine: {
    machineName?: string;
    machineId: MachineId;
  };
  createdAt?: string;
}

export function getCredentialsFilePath(dataDir: string = getLodyDataDir()): string {
  return path.join(dataDir, CREDENTIALS_FILE_NAME);
}

export function readCredentialsFile(dataDir: string = getLodyDataDir()): CredentialsV3 | null {
  try {
    const raw = fs.readFileSync(getCredentialsFilePath(dataDir), 'utf8');
    const parsed = CredentialsV3Schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function readCredentialsFileStrict(
  dataDir: string = getLodyDataDir()
): { raw: string; credentials: CredentialsV3 } | null {
  const credentialsPath = getCredentialsFilePath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(credentialsPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new Error(
      `Existing credentials file at ${credentialsPath} is not valid JSON. Fix or remove it before restoring.`
    );
  }

  const parsed = CredentialsV3Schema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(
      `Existing credentials file at ${credentialsPath} has an unsupported format and cannot be updated safely.`
    );
  }

  return { raw, credentials: parsed.data };
}

export function writeCredentialsFile(
  credentials: CredentialsV3Write,
  dataDir: string = getLodyDataDir()
): void {
  writePrivateCredentialFile(getCredentialsFilePath(dataDir), JSON.stringify(credentials, null, 2));
}

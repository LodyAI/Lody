import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { withFileLock } from '@/utils/file-lock';

const StoredOAuthBindingSchema = z
  .object({
    kind: z.literal('oauth'),
    tokens: z
      .object({
        access_token: z.string().min(1),
        token_type: z.string().min(1),
        expires_in: z.number().finite().positive().optional(),
        refresh_token: z.string().min(1).optional(),
        scope: z.string().optional(),
        id_token: z.string().optional(),
      })
      .strict(),
    clientInformation: z.record(z.string(), z.unknown()).optional(),
    discoveryState: z.record(z.string(), z.unknown()).optional(),
    redirectUrl: z.string().url(),
    authorizationFingerprint: z.string().min(1),
    credentialId: z.string().min(1),
    savedAt: z.number().finite().nonnegative(),
    connectedAt: z.number().finite().nonnegative(),
  })
  .strict();

const StoredSecretUrlBindingSchema = z
  .object({
    kind: z.literal('secret_url'),
    url: z.string().url(),
    authorizationFingerprint: z.string().min(1),
    credentialId: z.string().min(1),
    connectedAt: z.number().finite().nonnegative(),
  })
  .strict();

const StoredBindingSchema = z.discriminatedUnion('kind', [
  StoredOAuthBindingSchema,
  StoredSecretUrlBindingSchema,
]);
export type StoredWorkspaceMcpBinding = z.infer<typeof StoredBindingSchema>;

const PlaintextStoreSchema = z
  .object({
    version: z.literal(1),
    bindings: z.record(z.string(), StoredBindingSchema),
  })
  .strict();

const EncryptedStoreSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal('aes-256-gcm'),
    iv: z.string().min(1),
    tag: z.string().min(1),
    ciphertext: z.string().min(1),
  })
  .strict();

type PlaintextStore = z.infer<typeof PlaintextStoreSchema>;

export type WorkspaceMcpCredentialStoreOptions = {
  rootDir?: string;
};

/**
 * Machine-local encrypted credential storage.
 *
 * The random AES key and ciphertext are separate owner-only files. This keeps
 * credentials out of workspace Flocks, logs, RPC history, and normal backups.
 * File permissions are a defense boundary; an attacker already running as the
 * daemon's OS user can read both files and is outside this store's threat model.
 */
export class WorkspaceMcpCredentialStore {
  private readonly rootDir: string;
  private readonly keyPath: string;
  private readonly storePath: string;
  private readonly lockName: string;

  constructor(options: WorkspaceMcpCredentialStoreOptions = {}) {
    this.rootDir = options.rootDir ?? path.join(getLodyDataDir(), 'workspace-mcp');
    this.keyPath = path.join(this.rootDir, 'credentials.key');
    this.storePath = path.join(this.rootDir, 'credentials.enc.json');
    this.lockName = `workspace-mcp-credentials-${createHash('sha256')
      .update(this.storePath)
      .digest('hex')
      .slice(0, 16)}`;
  }

  async get(bindingKey: string): Promise<StoredWorkspaceMcpBinding | undefined> {
    const store = await this.readStore();
    return store.bindings[bindingKey];
  }

  async set(bindingKey: string, binding: StoredWorkspaceMcpBinding): Promise<void> {
    await this.mutate((store) => {
      store.bindings[bindingKey] = StoredBindingSchema.parse(binding);
    });
  }

  async delete(bindingKey: string): Promise<void> {
    await this.mutate((store) => {
      delete store.bindings[bindingKey];
    });
  }

  async deleteIf(
    bindingKey: string,
    predicate: (binding: StoredWorkspaceMcpBinding) => boolean
  ): Promise<void> {
    await this.mutate((store) => {
      const binding = store.bindings[bindingKey];
      if (binding && predicate(binding)) delete store.bindings[bindingKey];
    });
  }

  async keys(prefix = ''): Promise<string[]> {
    const store = await this.readStore();
    return Object.keys(store.bindings).filter((key) => key.startsWith(prefix));
  }

  private async mutate(update: (store: PlaintextStore) => void): Promise<void> {
    await withFileLock(this.lockName, async () => {
      const store = await this.readStore();
      update(store);
      await this.writeStore(store);
    });
  }

  private async readStore(): Promise<PlaintextStore> {
    try {
      const [rawEnvelope, key] = await Promise.all([
        readFile(this.storePath, 'utf8'),
        readFile(this.keyPath),
      ]);
      if (key.byteLength !== 32) throw new Error('Workspace MCP credential key is invalid.');
      const envelope = EncryptedStoreSchema.parse(JSON.parse(rawEnvelope));
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      return PlaintextStoreSchema.parse(JSON.parse(plaintext));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, bindings: {} };
      }
      throw error;
    }
  }

  private async ensureKey(): Promise<Buffer> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    try {
      const existing = await readFile(this.keyPath);
      if (existing.byteLength !== 32) {
        throw new Error('Workspace MCP credential key is invalid.');
      }
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const key = randomBytes(32);
    try {
      await writeFile(this.keyPath, key, { mode: 0o600, flag: 'wx' });
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readFile(this.keyPath);
      if (existing.byteLength !== 32) {
        throw new Error('Workspace MCP credential key is invalid.', { cause: error });
      }
      return existing;
    }
  }

  private async writeStore(store: PlaintextStore): Promise<void> {
    const key = await this.ensureKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(PlaintextStoreSchema.parse(store)), 'utf8'),
      cipher.final(),
    ]);
    const envelope = {
      version: 1 as const,
      algorithm: 'aes-256-gcm' as const,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    const tempPath = `${this.storePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(envelope), { mode: 0o600, flag: 'wx' });
      await rename(tempPath, this.storePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

export const asOAuthTokens = (binding: StoredWorkspaceMcpBinding): OAuthTokens | undefined =>
  binding.kind === 'oauth' ? binding.tokens : undefined;

export const asOAuthClientInformation = (
  binding: StoredWorkspaceMcpBinding
): OAuthClientInformationMixed | undefined =>
  binding.kind === 'oauth'
    ? (binding.clientInformation as OAuthClientInformationMixed | undefined)
    : undefined;

export const asOAuthDiscoveryState = (
  binding: StoredWorkspaceMcpBinding
): OAuthDiscoveryState | undefined =>
  binding.kind === 'oauth'
    ? (binding.discoveryState as OAuthDiscoveryState | undefined)
    : undefined;

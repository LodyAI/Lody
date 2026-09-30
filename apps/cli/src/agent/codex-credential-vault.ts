import type { AsyncEntry } from '@napi-rs/keyring';

export interface CodexCredentialVault {
  get(id: string): Promise<string | undefined>;
  set(id: string, value: string): Promise<void>;
  delete(id: string): Promise<void>;
}

/** The daemon owns the OS credential entry; Linux requires durable Secret Service. */
export class SystemCodexCredentialVault implements CodexCredentialVault {
  private async entry(id: string): Promise<AsyncEntry> {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    return new AsyncEntry('Lody Codex Profiles', id, { linux: { store: 'secret-service' } });
  }

  async get(id: string): Promise<string | undefined> {
    try {
      return await (await this.entry(id)).getPassword(AbortSignal.timeout(30_000));
    } catch {
      throw new Error('The system credential store is unavailable or locked');
    }
  }

  async set(id: string, value: string): Promise<void> {
    try {
      await (await this.entry(id)).setPassword(value, AbortSignal.timeout(30_000));
    } catch {
      throw new Error('Could not save the credential in the system credential store');
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await (await this.entry(id)).deleteCredential(AbortSignal.timeout(30_000));
    } catch {
      throw new Error('Could not remove the credential from the system credential store');
    }
  }
}

export const DEFAULT_CLI_API_KEY_NAME = 'Lody CLI Token';

export type CliApiKeyRecord = {
  id: string;
  name: string;
  keyStart: string | null;
  keyPreview: string | null;
  note: string | null;
  source?: 'auto' | 'manual' | 'pairing' | null;
  createdAt: number | null;
  lastRequest: number | null;
  /**
   * When the key stops authorizing. Records that carry `machineIds` report the
   * effective time (an auto key's idle limit included); older backends report
   * only the stored expiry.
   */
  expiresAt: number | null;
  enabled: boolean;
  /** The owner's machines this key signs in. Absent from older backends. */
  machineIds?: string[];
};

export type GenerateCliApiKeyResult =
  | {
      ok: true;
      apiKey: string;
      apiKeyId?: string;
      apiKeyStart?: string | null;
      record?: CliApiKeyRecord;
    }
  | {
      ok: false;
      error: string;
    };

export function maskCliApiKeySecret(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 12) {
    return trimmed;
  }

  const head = trimmed.slice(0, 12);
  const tail = trimmed.length > 18 ? trimmed.slice(-6) : '';
  return `${head}******${tail}`;
}

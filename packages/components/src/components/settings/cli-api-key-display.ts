import type { CliApiKeyRecord } from '@lody/shared';
import type { TFunction } from 'i18next';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';

/** What a CLI token row says, so a person can tell which ones are safe to revoke. */
export type CliApiKeyDisplay = {
  /** The bound machines' names, else the user's note, else a fallback. */
  title: string;
  /** This token signs in the computer showing the page. */
  isCurrentMachine: boolean;
  sourceLabel: string | null;
  /** Null while the backend does not report lifetimes (records without `machineIds`). */
  lifetime: string | null;
  createdAt: string | null;
  lastUsed: string | null;
};

export function formatCliApiKeyTimestamp(value: number | null, language: string): string | null {
  if (value === null) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(toIntlLocaleOrEn(language), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function describeCliApiKey(
  apiKey: CliApiKeyRecord,
  context: {
    machineNamesById: ReadonlyMap<string, string>;
    currentMachineId: string | null;
    language: string;
    t: TFunction;
  }
): CliApiKeyDisplay {
  const { machineNamesById, currentMachineId, language, t } = context;
  const machineIds = apiKey.machineIds ?? [];
  const knownNames = machineIds.flatMap((id) => {
    const name = machineNamesById.get(id);
    return name ? [name] : [];
  });
  const unknownCount = machineIds.length - knownNames.length;
  const machineTitle =
    machineIds.length === 0
      ? null
      : [
          ...knownNames,
          ...(unknownCount > 0 ? [t('settings.account.cliAuth.otherDevice')] : []),
        ].join(t('settings.account.cliAuth.deviceSeparator'));

  const sourceLabel =
    apiKey.source === 'auto'
      ? t('settings.account.cliAuth.sourceAuto')
      : apiKey.source === 'manual'
        ? t('settings.account.cliAuth.sourceManual')
        : apiKey.source === 'pairing'
          ? t('settings.account.cliAuth.sourcePairing')
          : null;

  // Older backends send neither machines nor an effective expiry; their raw
  // `expiresAt` would wrongly read "never expires" for idle-limited auto keys.
  const expiresAt = formatCliApiKeyTimestamp(apiKey.expiresAt, language);
  const lifetime =
    apiKey.machineIds === undefined
      ? null
      : expiresAt === null
        ? t('settings.account.cliAuth.neverExpires')
        : apiKey.source === 'auto'
          ? t('settings.account.cliAuth.idleExpiresAt', { at: expiresAt })
          : t('settings.account.cliAuth.expiresAt', { at: expiresAt });

  const createdAt = formatCliApiKeyTimestamp(apiKey.createdAt, language);
  const lastUsed = formatCliApiKeyTimestamp(apiKey.lastRequest, language);

  return {
    title: machineTitle ?? (apiKey.note || t('settings.account.cliAuth.recordNoteFallback')),
    isCurrentMachine: currentMachineId !== null && machineIds.includes(currentMachineId),
    sourceLabel,
    lifetime,
    createdAt: createdAt ? t('settings.account.cliAuth.createdAt', { at: createdAt }) : null,
    lastUsed: lastUsed ? t('settings.account.cliAuth.lastUsed', { at: lastUsed }) : null,
  };
}

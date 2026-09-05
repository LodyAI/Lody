import { isAcpFastModeConfigId } from '@lody/shared';
import { useTranslation } from 'react-i18next';
import type { AcpConfigOptionSelector, AcpConfigOptionValue } from './acp-selector-options';

/** A missing catalog entry is not a runtime rejection or an empty supported set. */
export function AcpControlAvailability({
  selector,
  value,
}: {
  selector: AcpConfigOptionSelector;
  value?: AcpConfigOptionValue;
}) {
  const { t } = useTranslation();
  const isFast = isAcpFastModeConfigId(selector.configId);
  if (!selector.availability) return null;
  return (
    <div className="max-w-72 px-2 py-1.5 text-xs text-muted-foreground" role="status">
      <p className="font-medium text-foreground">
        {selector.availability === 'unknown'
          ? isFast
            ? t('chat.fastCapabilitiesUnknown')
            : t('chat.reasoningCapabilitiesUnknown')
          : isFast
            ? t('chat.fastCapabilitiesUnsupported')
            : t('chat.reasoningCapabilitiesUnsupported')}
      </p>
      {selector.availability === 'unknown' ? (
        <p className="mt-1">{t('chat.reasoningCapabilitiesRefreshHint')}</p>
      ) : null}
      {value !== undefined && value !== '' ? (
        <p className="mt-1">{t('chat.retainedConfigValue', { value: String(value) })}</p>
      ) : null}
    </div>
  );
}

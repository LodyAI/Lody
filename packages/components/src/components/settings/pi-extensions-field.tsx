import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScanSearch } from 'lucide-react';
import {
  PI_EXTENSION_PATH_MAX_LENGTH,
  PI_EXTENSIONS_MAX_SELECTIONS,
  type MachinePiExtensionsResponse,
  type PiExtensionDiscovery,
} from '@lody/shared';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Input } from '@/ui/input';
import { Spinner } from '@/ui/spinner';
import { CollapsibleSection, FormMessage } from './form-primitives';

const ABSOLUTE_PATH_PATTERN = /^(?:\/|~(?:[/\\]|$)|[a-zA-Z]:[\\/]|\\\\)/;

export function PiExtensionsField({
  value,
  onChange,
  onScan,
  supported,
}: {
  value: string[];
  onChange: (paths: string[]) => void;
  onScan?: () => Promise<MachinePiExtensionsResponse>;
  supported: boolean;
}) {
  const { t } = useTranslation();
  const [discovery, setDiscovery] = useState<PiExtensionDiscovery>();
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [path, setPath] = useState('');
  const scan = async () => {
    if (!onScan || !supported) return;
    setScanning(true);
    setError('');
    try {
      const result = await onScan();
      if (result.success) setDiscovery(result.discovery);
      else setError(result.error);
    } catch {
      setError(t('piExtensions.scanFailed'));
    } finally {
      setScanning(false);
    }
  };
  const rows: { path: string; name: string; stale: boolean }[] = (
    discovery?.extensions ?? []
  ).map((item) => ({ path: item.path, name: item.name, stale: false }));
  const discovered = new Set(rows.map((row) => row.path));
  for (const selected of value)
    if (!discovered.has(selected))
      rows.push({
        path: selected,
        name: selected.split(/[\\/]/).pop() ?? selected,
        stale: discovery !== undefined,
      });
  const add = (candidate: string): boolean => {
    if (!supported || value.includes(candidate)) return false;
    if (
      candidate.length === 0 ||
      candidate.length > PI_EXTENSION_PATH_MAX_LENGTH ||
      !ABSOLUTE_PATH_PATTERN.test(candidate)
    ) {
      setError(t('piExtensions.invalidPath'));
      return false;
    }
    if (value.length >= PI_EXTENSIONS_MAX_SELECTIONS) {
      setError(t('piExtensions.limit'));
      return false;
    }
    onChange([...value, candidate]);
    setError('');
    return true;
  };
  return (
    <CollapsibleSection
      title={t('piExtensions.title')}
      count={value.length}
      defaultOpen
      disabled={!supported && value.length === 0}
      disabledHint={t('piExtensions.unsupported')}
      action={
        supported && onScan ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={scanning}
            onClick={() => void scan()}
          >
            {scanning ? (
              <Spinner className="h-3.5 w-3.5" />
            ) : (
              <ScanSearch className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {scanning
              ? t('piExtensions.scanning')
              : discovery
                ? t('piExtensions.rescan')
                : t('piExtensions.scan')}
          </Button>
        ) : null
      }
    >
      <div role="group" aria-label={t('piExtensions.title')} className="space-y-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('piExtensions.consent')}
        </p>
        {supported && onScan ? (
          <p className="text-[11px] leading-snug text-muted-foreground">
            {t('piExtensions.profileHint')}
          </p>
        ) : null}
        {!supported ? (
          <FormMessage tone="warning">{t('piExtensions.unsupported')}</FormMessage>
        ) : null}
        {discovery ? (
          <>
            <p className="text-[11px] text-muted-foreground">
              {t('piExtensions.scannedDir', { dir: discovery.agentDir })}
            </p>
            {discovery.warnings.length > 0 ? (
              <FormMessage tone="warning">
                <ul className="list-disc space-y-0.5 pl-4">
                  {discovery.warnings.map((warning, index) => (
                    <li key={index} className="break-words">
                      {warning}
                    </li>
                  ))}
                </ul>
              </FormMessage>
            ) : null}
            {discovery.extensions.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('piExtensions.empty')}</p>
            ) : null}
          </>
        ) : null}
        {rows.length > 0 ? (
          <div className="max-h-56 divide-y divide-border/60 overflow-y-auto rounded-md border border-border/60">
            {rows.map((row) => {
              const checked = value.includes(row.path);
              const rowDisabled = !supported && !checked;
              return (
                <label
                  key={row.path}
                  className={cn(
                    'flex items-start gap-2.5 px-3 py-2',
                    rowDisabled
                      ? 'opacity-60'
                      : 'cursor-pointer transition-colors hover:bg-tab-hover/40'
                  )}
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={checked}
                    disabled={rowDisabled}
                    onCheckedChange={(next) => {
                      if (next === true) {
                        add(row.path);
                      } else {
                        onChange(value.filter((item) => item !== row.path));
                        setError('');
                      }
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-xs font-medium">{row.name}</span>
                      {row.stale ? (
                        <span className="shrink-0 text-[10px] text-status-warning">
                          {t('piExtensions.stale')}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className="block truncate font-mono text-[11px] text-muted-foreground"
                      title={row.path}
                    >
                      {row.path}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        ) : null}
        {supported ? (
          <div className="flex gap-2">
            <Input
              aria-label={t('piExtensions.path')}
              placeholder={t('piExtensions.placeholder')}
              value={path}
              onChange={(event) => setPath(event.target.value)}
              className="h-9 min-w-0 flex-1 font-mono text-xs"
            />
            <Button
              type="button"
              variant="secondary"
              disabled={!path.trim() || value.length >= PI_EXTENSIONS_MAX_SELECTIONS}
              onClick={() => {
                if (add(path.trim())) setPath('');
              }}
            >
              {t('piExtensions.add')}
            </Button>
          </div>
        ) : null}
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      </div>
    </CollapsibleSection>
  );
}

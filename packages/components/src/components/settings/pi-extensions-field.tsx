import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScanSearch } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import {
  PI_EXTENSION_PATH_MAX_LENGTH,
  PI_EXTENSIONS_MAX_SELECTIONS,
  type MachinePiExtensionsResponse,
  type PiExtensionDiscovery,
} from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Checkbox } from '@lody/ui/checkbox';
import { Input } from '@lody/ui/input';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space } from '@lody/ui/tokens/scales.stylex';
import { CollapsibleSection, FormMessage } from './form-primitives';

const ABSOLUTE_PATH_PATTERN = /^(?:\/|~(?:[/\\]|$)|[a-zA-Z]:[\\/]|\\\\)/;
const MONO = 'var(--font-mono, ui-monospace, monospace)';

const styles = stylex.create({
  group: { display: 'flex', flexDirection: 'column', gap: space[3] },
  consent: {
    margin: 0,
    fontSize: '12px',
    lineHeight: 1.5,
    color: colors.secondaryLabel,
  },
  hint: {
    margin: 0,
    fontSize: '11px',
    lineHeight: 1.375,
    color: colors.secondaryLabel,
  },
  warningList: {
    margin: 0,
    paddingInlineStart: space[4],
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    listStyleType: 'disc',
  },
  breakWords: { overflowWrap: 'break-word' },
  /** The picked rows are a list of records: one region, ruled lines. */
  list: {
    maxHeight: '224px',
    overflowY: 'auto',
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 3%)`,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
  },
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    paddingInline: space[3],
    paddingBlock: space[2],
  },
  rowRuled: { boxShadow: `inset 0 1px 0 ${colors.separator}` },
  rowEnabled: {
    cursor: 'pointer',
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
  },
  rowDisabled: { opacity: 0.6 },
  checkbox: { marginTop: '2px' },
  rowBody: { flexGrow: 1, minWidth: 0 },
  rowHead: { display: 'flex', alignItems: 'baseline', gap: space[2] },
  rowName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '12px',
    fontWeight: 500,
    color: colors.label,
  },
  stale: { flexShrink: 0, fontSize: '10px', color: colors.warning },
  rowPath: {
    display: 'block',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: MONO,
    fontSize: '11px',
    color: colors.secondaryLabel,
  },
  inputRow: { display: 'flex', gap: space[2] },
  input: { flexGrow: 1, minWidth: 0 },
});

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
  const rows: { path: string; name: string; stale: boolean }[] = (discovery?.extensions ?? []).map(
    (item) => ({ path: item.path, name: item.name, stale: false })
  );
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
            size="small"
            variant="secondary"
            disabled={scanning}
            onClick={() => void scan()}
          >
            {scanning ? (
              <Spinner size="small" />
            ) : (
              <ScanSearch width={14} height={14} aria-hidden="true" />
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
      <div role="group" aria-label={t('piExtensions.title')} {...stylex.props(styles.group)}>
        <p {...stylex.props(styles.consent)}>{t('piExtensions.consent')}</p>
        {supported && onScan ? (
          <p {...stylex.props(styles.hint)}>{t('piExtensions.profileHint')}</p>
        ) : null}
        {!supported ? (
          <FormMessage tone="warning">{t('piExtensions.unsupported')}</FormMessage>
        ) : null}
        {discovery ? (
          <>
            <p {...stylex.props(styles.hint)}>
              {t('piExtensions.scannedDir', { dir: discovery.agentDir })}
            </p>
            {discovery.warnings.length > 0 ? (
              <FormMessage tone="warning">
                <ul {...stylex.props(styles.warningList)}>
                  {discovery.warnings.map((warning, index) => (
                    <li key={index} {...stylex.props(styles.breakWords)}>
                      {warning}
                    </li>
                  ))}
                </ul>
              </FormMessage>
            ) : null}
            {discovery.extensions.length === 0 ? (
              <p {...stylex.props(styles.consent)}>{t('piExtensions.empty')}</p>
            ) : null}
          </>
        ) : null}
        {rows.length > 0 ? (
          <div {...stylex.props(styles.list)}>
            {rows.map((row, index) => {
              const checked = value.includes(row.path);
              const rowDisabled = !supported && !checked;
              return (
                <label
                  key={row.path}
                  {...stylex.props(
                    styles.row,
                    index > 0 && styles.rowRuled,
                    rowDisabled ? styles.rowDisabled : styles.rowEnabled
                  )}
                >
                  <Checkbox
                    className={stylex.props(styles.checkbox).className}
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
                  <span {...stylex.props(styles.rowBody)}>
                    <span {...stylex.props(styles.rowHead)}>
                      <span {...stylex.props(styles.rowName)}>{row.name}</span>
                      {row.stale ? (
                        <span {...stylex.props(styles.stale)}>{t('piExtensions.stale')}</span>
                      ) : null}
                    </span>
                    <span {...stylex.props(styles.rowPath)} title={row.path}>
                      {row.path}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        ) : null}
        {supported ? (
          <div {...stylex.props(styles.inputRow)}>
            <Input
              aria-label={t('piExtensions.path')}
              placeholder={t('piExtensions.placeholder')}
              value={path}
              onChange={(event) => setPath(event.target.value)}
              className={stylex.props(styles.input).className}
              style={{ fontFamily: MONO }}
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

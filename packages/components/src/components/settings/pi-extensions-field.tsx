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
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { Checkbox } from '@lody/ui/checkbox';
import { Input } from '@lody/ui/input';
import { Spinner } from '@lody/ui/spinner';
import { CollapsibleSection, FormMessage } from './form-primitives';

const ABSOLUTE_PATH_PATTERN = /^(?:\/|~(?:[/\\]|$)|[a-zA-Z]:[\\/]|\\\\)/;
const MONO = 'var(--font-mono, ui-monospace, monospace)';
const REGION = `color-mix(in oklab, transparent, ${colors.label} 3%)`;
const TRUNCATE = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

const styles = stylex.create({
  group: { display: 'flex', flexDirection: 'column', gap: space[3] },
  copy: { margin: 0, fontSize: '12px', lineHeight: 1.5, color: colors.secondaryLabel },
  hint: { margin: 0, fontSize: '11px', lineHeight: 1.375, color: colors.secondaryLabel },
  warningsList: { margin: 0, paddingInlineStart: space[4], listStyleType: 'disc' },
  warningItem: { overflowWrap: 'break-word' },
  /** The discovered paths: a recessed list of ruled rows, not a bordered box. */
  rows: {
    maxHeight: '14rem',
    overflowY: 'auto',
    backgroundColor: REGION,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
  },
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    paddingInline: space[3],
    paddingBlock: space[2],
    boxShadow: { default: `inset 0 1px 0 ${colors.separator}`, ':first-child': 'none' },
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    cursor: 'pointer',
  },
  rowDisabled: { opacity: 0.6, cursor: 'default' },
  check: { display: 'inline-flex', flexShrink: 0, marginTop: '2px' },
  rowBody: { minWidth: 0, flexGrow: 1 },
  rowNameLine: { display: 'flex', alignItems: 'baseline', gap: space[2] },
  rowName: { ...TRUNCATE, fontSize: '12px', fontWeight: 500, color: colors.label },
  stale: { flexShrink: 0, fontSize: '10px', color: colors.warning },
  rowPath: {
    display: 'block',
    ...TRUNCATE,
    fontFamily: MONO,
    fontSize: '11px',
    color: colors.secondaryLabel,
  },
  addRow: { display: 'flex', gap: space[2] },
  addInput: { flexGrow: 1, minWidth: 0, fontFamily: MONO },
  icon14: { flexShrink: 0, width: '14px', height: '14px' },
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
              <ScanSearch aria-hidden="true" {...stylex.props(styles.icon14)} />
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
        <p {...stylex.props(styles.copy)}>{t('piExtensions.consent')}</p>
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
                <ul {...stylex.props(styles.warningsList)}>
                  {discovery.warnings.map((warning, index) => (
                    <li key={index} {...stylex.props(styles.warningItem)}>
                      {warning}
                    </li>
                  ))}
                </ul>
              </FormMessage>
            ) : null}
            {discovery.extensions.length === 0 ? (
              <p {...stylex.props(styles.copy)}>{t('piExtensions.empty')}</p>
            ) : null}
          </>
        ) : null}
        {rows.length > 0 ? (
          <div {...stylex.props(styles.rows)}>
            {rows.map((row) => {
              const checked = value.includes(row.path);
              const rowDisabled = !supported && !checked;
              return (
                <label
                  key={row.path}
                  {...stylex.props(styles.row, rowDisabled && styles.rowDisabled)}
                >
                  <span {...stylex.props(styles.check)}>
                    <Checkbox
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
                  </span>
                  <span {...stylex.props(styles.rowBody)}>
                    <span {...stylex.props(styles.rowNameLine)}>
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
          <div {...stylex.props(styles.addRow)}>
            <span {...stylex.props(styles.addInput)}>
              <Input
                aria-label={t('piExtensions.path')}
                placeholder={t('piExtensions.placeholder')}
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
            </span>
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

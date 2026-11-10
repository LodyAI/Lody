import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@lody/ui/alert';
import { Badge, type BadgeTone } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text as type } from '@lody/ui/tokens/scales.stylex';

type Method = 'passkey' | 'file' | 'none';
type RestoreResult = { workspaceId?: string; name: string; outcome: string };
type Restored =
  | { outcome: 'cancelled' }
  | {
      outcome: 'restored';
      results: readonly RestoreResult[];
    };

export interface E2eeLostAllRecoveryProps {
  /** The workspace this device is waiting to open. Only its own committed restore may
   * end that wait; another workspace's success never does. */
  workspaceId: string;
  /** Whether this device can attempt a passkey ceremony; the passkey choice leads when it can. */
  passkeyAvailable: boolean;
  /** Restores every workspace the chosen backup covers onto this device. */
  restore: (method: 'file' | 'passkey') => Promise<Restored>;
  /** This workspace was restored: leave the waiting page and open it. */
  onRecovered: () => void;
}

const styles = stylex.create({
  root: { display: 'flex', flexDirection: 'column', gap: space[4], textAlign: 'start' },
  lead: { margin: 0, color: colors.secondaryLabel, fontSize: type.subheadlineSize },
  options: { display: 'flex', flexDirection: 'column', gap: space[2] },
  option: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1],
    padding: space[3],
    borderRadius: radius.large,
    borderWidth: 1.5,
    borderStyle: 'solid',
    borderColor: colors.separator,
    backgroundColor: colors.elevatedBackground,
    color: colors.label,
    font: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
  },
  optionSelected: { borderColor: colors.label, boxShadow: shadow.card },
  optionTitle: { fontWeight: 600 },
  optionHelp: { color: colors.secondaryLabel, fontSize: type.footnoteSize },
  list: {
    listStyle: 'none',
    margin: 0,
    paddingBlock: space[1],
    paddingInline: space[4],
    borderRadius: radius.large,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
    minHeight: 40,
    borderBottomWidth: { default: 1, ':last-child': 0 },
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
  },
  heading: { margin: 0, fontSize: type.headlineSize, fontWeight: 600 },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: space[2], flexWrap: 'wrap' },
});

const resultBadge = (outcome: string): { key: string; tone: BadgeTone } =>
  outcome === 'Committed'
    ? { key: 'e2ee.lostAll.result.restored', tone: 'success' }
    : outcome === 'Pending'
      ? { key: 'e2ee.lostAll.result.waiting', tone: 'neutral' }
      : { key: 'e2ee.lostAll.result.failed', tone: 'warning' };

const failureKey = (code: string) =>
  code.includes('e2ee_recovery_prf-unavailable')
    ? 'e2ee.recovery.passkeyUnsupported'
    : /e2ee_recovery_(?:authentication|invalid-input)/.test(code)
      ? 'e2ee.recovery.wrongFile'
      : code.includes('e2ee_recovery_disabled')
        ? 'e2ee.recovery.disabled'
        : 'e2ee.recovery.failed';

/** "I lost every authorized device": restore from a passkey or the recovery file, with
 * each workspace's outcome, and a pointer to revoking the lost devices afterwards. */
export function E2eeLostAllRecovery(props: E2eeLostAllRecoveryProps) {
  const { t } = useTranslation();
  const [method, setMethod] = useState<Method>(props.passkeyAvailable ? 'passkey' : 'file');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<readonly RestoreResult[] | null>(null);
  const choices: Method[] = [
    ...(props.passkeyAvailable ? (['passkey'] as const) : []),
    'file',
    'none',
  ];
  const run = async () => {
    if (busy || method === 'none') return;
    setBusy(true);
    setError(null);
    try {
      const restored = await props.restore(method);
      if (restored.outcome === 'restored') setResults(restored.results);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      // Dismissing the system prompt is a choice, not a failure.
      if (!code.includes('e2ee_recovery_cancelled')) setError(failureKey(code));
    } finally {
      setBusy(false);
    }
  };

  if (results) {
    const restored = results.filter((row) => row.outcome === 'Committed').length;
    const unfinished = results.length - restored;
    // Matched by ID: names are display text and may repeat.
    const current = results.some(
      (row) => row.workspaceId === props.workspaceId && row.outcome === 'Committed'
    );
    return (
      <div data-testid="e2ee-lost-all-results" {...stylex.props(styles.root)}>
        <h3 {...stylex.props(styles.heading)}>
          {results.length === 0
            ? t('e2ee.lostAll.result.none')
            : t('e2ee.lostAll.result.title', { count: restored })}
        </h3>
        {results.length > 0 && (
          <ul {...stylex.props(styles.list)}>
            {results.map((row) => {
              const badge = resultBadge(row.outcome);
              return (
                <li
                  key={row.workspaceId ?? row.name}
                  data-lost-all-result={row.outcome}
                  {...stylex.props(styles.row)}
                >
                  <span>{row.name}</span>
                  <Badge tone={badge.tone}>{t(badge.key)}</Badge>
                </li>
              );
            })}
          </ul>
        )}
        {(unfinished > 0 || results.length === 0) && (
          <p {...stylex.props(styles.lead)}>{t('e2ee.lostAll.result.askAdmin')}</p>
        )}
        {restored > 0 && !current && (
          <p data-testid="e2ee-lost-all-current-pending" {...stylex.props(styles.lead)}>
            {t('e2ee.lostAll.result.currentPending')}
          </p>
        )}
        {restored > 0 && (
          <p {...stylex.props(styles.lead)}>{t('e2ee.lostAll.result.revokeHint')}</p>
        )}
        <div {...stylex.props(styles.actions)}>
          {!current && (
            <Button variant="secondary" onClick={() => setResults(null)}>
              {t('e2ee.lostAll.tryAnother')}
            </Button>
          )}
          {current && <Button onClick={props.onRecovered}>{t('e2ee.lostAll.open')}</Button>}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="e2ee-lost-all" {...stylex.props(styles.root)}>
      <p {...stylex.props(styles.lead)}>{t('e2ee.lostAll.lead')}</p>
      <div role="radiogroup" aria-label={t('e2ee.lostAll.title')} {...stylex.props(styles.options)}>
        {choices.map((choice) => (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={method === choice}
            data-lost-all-method={choice}
            disabled={busy}
            onClick={() => setMethod(choice)}
            {...stylex.props(styles.option, method === choice && styles.optionSelected)}
          >
            <span {...stylex.props(styles.optionTitle)}>{t(`e2ee.lostAll.${choice}.title`)}</span>
            <span {...stylex.props(styles.optionHelp)}>{t(`e2ee.lostAll.${choice}.help`)}</span>
          </button>
        ))}
      </div>
      {error && (
        <Alert.Root tone="danger">
          <Alert.Description>{t(error)}</Alert.Description>
        </Alert.Root>
      )}
      <div {...stylex.props(styles.actions)}>
        <Button disabled={busy || method === 'none'} onClick={() => void run()}>
          {t('e2ee.lostAll.continue')}
        </Button>
      </div>
    </div>
  );
}

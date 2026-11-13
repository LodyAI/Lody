import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@lody/ui/alert';
import { Badge, type BadgeTone } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text as type } from '@lody/ui/tokens/scales.stylex';

type Method = 'passkey' | 'password' | 'file';
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
  restore: (
    method: 'file' | 'passkey' | 'password',
    options?: { readonly password?: string }
  ) => Promise<Restored>;
  /** This workspace was restored: leave the waiting page and open it. */
  onRecovered: () => void;
  /** A host whose results name no workspace IDs restored something: re-read this
   * device's status, the only authority on whether this workspace is open.
   * It never ends the pending request. */
  onCheck?: () => void;
  /** The person has neither backup: go on to what can still be done. */
  onNoBackup?: () => void;
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
  passwordField: { display: 'flex', flexDirection: 'column', gap: space[1] },
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
  split: { justifyContent: 'space-between', alignItems: 'center' },
});

const resultBadge = (outcome: string): { key: string; tone: BadgeTone } =>
  outcome === 'Committed'
    ? { key: 'e2ee.lostAll.result.restored', tone: 'success' }
    : outcome === 'Pending'
      ? { key: 'e2ee.lostAll.result.waiting', tone: 'neutral' }
      : { key: 'e2ee.lostAll.result.failed', tone: 'warning' };

const failureKey = (code: string, method: Method) =>
  code.includes('e2ee_recovery_missing')
    ? 'e2ee.lostAll.missing'
    : code.includes('e2ee_recovery_prf-unavailable')
      ? 'e2ee.recovery.passkeyUnsupported'
      : /e2ee_recovery_(?:authentication|invalid-input)/.test(code)
        ? method === 'password'
          ? 'e2ee.recovery.wrongPassword'
          : 'e2ee.recovery.wrongFile'
        : code.includes('e2ee_recovery_disabled')
          ? 'e2ee.recovery.disabled'
          : 'e2ee.lostAll.failed';

const MIN_PASSWORD_CHARS = 12;
const validPasswordInput = (value: string) =>
  [...value.normalize('NFC')].length >= MIN_PASSWORD_CHARS &&
  new TextEncoder().encode(value.normalize('NFC')).byteLength <= 1024;

/** "I lost every authorized device": restore from a passkey, recovery password or
 * recovery file, with each workspace's outcome, and a pointer to revoking lost devices. */
export function E2eeLostAllRecovery(props: E2eeLostAllRecoveryProps) {
  const { t } = useTranslation();
  const [method, setMethod] = useState<Method>(props.passkeyAvailable ? 'passkey' : 'password');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<readonly RestoreResult[] | null>(null);
  const choices: Method[] = [
    ...(props.passkeyAvailable ? (['passkey'] as const) : []),
    'password',
    'file',
  ];
  const optionCopy: Record<Method, { title: string; help: string }> = {
    passkey: {
      title: t('e2ee.lostAll.passkey.title'),
      help: t('e2ee.lostAll.passkey.help'),
    },
    password: {
      title: t('e2ee.lostAll.password.title'),
      help: t('e2ee.lostAll.password.help'),
    },
    file: {
      title: t('e2ee.lostAll.file.title'),
      help: t('e2ee.lostAll.file.help'),
    },
  };
  const canSubmit = !busy && (method !== 'password' || validPasswordInput(password));
  const run = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const restored =
        method === 'password'
          ? await props.restore('password', { password })
          : await props.restore(method);
      if (restored.outcome === 'restored') {
        setPassword('');
        setResults(restored.results);
      }
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      // Dismissing the system prompt is a choice, not a failure.
      if (!code.includes('e2ee_recovery_cancelled')) setError(failureKey(code, method));
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
    // Hosts that report no IDs cannot say which row is this workspace; only a fresh
    // read of this device's status can, and it never ends the pending request.
    const unidentified =
      !current && restored > 0 && results.every((row) => row.workspaceId === undefined);
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
        {restored > 0 && !current && !unidentified && (
          <p data-testid="e2ee-lost-all-current-pending" {...stylex.props(styles.lead)}>
            {t('e2ee.lostAll.result.currentPending')}
          </p>
        )}
        {unidentified && (
          <p {...stylex.props(styles.lead)}>{t('e2ee.lostAll.result.checkCurrent')}</p>
        )}
        {restored > 0 && (
          <p {...stylex.props(styles.lead)}>{t('e2ee.lostAll.result.revokeHint')}</p>
        )}
        <div {...stylex.props(styles.actions)}>
          {!current && props.onNoBackup && unfinished > 0 && (
            <Button variant="secondary" onClick={props.onNoBackup}>
              {t('e2ee.lostAll.cannotRestore')}
            </Button>
          )}
          {!current && (
            <Button variant="secondary" onClick={() => setResults(null)}>
              {t('e2ee.lostAll.tryAnother')}
            </Button>
          )}
          {unidentified && props.onCheck && (
            <Button data-testid="e2ee-lost-all-check" onClick={props.onCheck}>
              {t('e2ee.lostAll.check')}
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
            onClick={() => {
              setMethod(choice);
              setError(null);
            }}
            {...stylex.props(styles.option, method === choice && styles.optionSelected)}
          >
            <span {...stylex.props(styles.optionTitle)}>{optionCopy[choice].title}</span>
            <span {...stylex.props(styles.optionHelp)}>{optionCopy[choice].help}</span>
          </button>
        ))}
      </div>
      {method === 'password' && (
        <div {...stylex.props(styles.passwordField)}>
          <Input
            type="password"
            autoComplete="current-password"
            data-testid="e2ee-lost-all-password"
            aria-label={t('e2ee.recovery.passwordLabel')}
            placeholder={t('e2ee.recovery.passwordPlaceholder')}
            disabled={busy}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && canSubmit) void run();
            }}
          />
          <span {...stylex.props(styles.optionHelp)}>{t('e2ee.recovery.passwordLengthHint')}</span>
        </div>
      )}
      {error && (
        <Alert.Root tone="danger">
          <Alert.Description>{t(error)}</Alert.Description>
        </Alert.Root>
      )}
      <div {...stylex.props(styles.actions, props.onNoBackup && styles.split)}>
        {props.onNoBackup && (
          <Button
            variant="link"
            data-testid="e2ee-lost-all-no-backup"
            disabled={busy}
            onClick={props.onNoBackup}
          >
            {t('e2ee.lostAll.noBackup')}
          </Button>
        )}
        <Button disabled={!canSubmit} onClick={() => void run()}>
          {t('e2ee.lostAll.continue')}
        </Button>
      </div>
    </div>
  );
}

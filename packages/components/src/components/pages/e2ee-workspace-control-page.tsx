import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, ShieldAlert, ShieldCheck } from 'lucide-react';
import { ledgerRecordFields, type VerifiedLedgerHistory } from '@/lib/e2ee-ledger-history';
import type { E2eeControlFailure } from '@/lib/e2ee-control-failure';

const styles = stylex.create({
  page: {
    minHeight: '100vh',
    overflowY: 'auto',
    backgroundColor: colors.background,
    color: colors.label,
    padding: space[6],
  },
  column: {
    maxWidth: 880,
    marginInline: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: space[6],
  },
  title: { fontSize: '1.5em', fontWeight: 600, marginBottom: space[2] },
  muted: { color: colors.secondaryLabel, lineHeight: 1.6 },
  card: {
    padding: space[4],
    borderRadius: radius.large,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.raised,
  },
  notice: { color: colors.warning, lineHeight: 1.6, marginTop: space[4] },
  heading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
    marginBottom: space[3],
  },
  records: {
    listStyle: 'none',
    padding: 0,
    marginTop: space[4],
    borderRadius: radius.large,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.raised,
    overflow: 'hidden',
  },
  record: {
    padding: space[4],
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
  },
  recordTitle: { fontSize: '1em', fontWeight: 600, marginBottom: space[3] },
  fields: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(100px, 160px) minmax(0, 1fr)',
      '@media (max-width: 520px)': 'minmax(0, 1fr)',
    },
    gap: space[2],
    fontSize: '0.9em',
    marginBottom: space[3],
  },
  fieldPair: { display: 'contents' },
  value: { margin: 0, overflowWrap: 'anywhere', fontFamily: 'monospace', userSelect: 'text' },
  raw: {
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    padding: space[3],
    marginTop: space[2],
    borderRadius: radius.small,
    backgroundColor: colors.wellBackground,
    boxShadow: shadow.inset,
    fontSize: '0.85em',
  },
  error: { color: colors.destructive },
  footer: { marginTop: space[4] },
  badges: { display: 'flex', flexWrap: 'wrap', gap: space[2], marginTop: space[3] },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
    paddingBlock: space[1],
    paddingInline: space[2],
    borderRadius: radius.small,
    backgroundColor: colors.wellBackground,
    boxShadow: shadow.inset,
    fontSize: '0.85em',
  },
  failure: { display: 'flex', flexDirection: 'column', gap: space[3], marginBlock: space[3] },
  actions: { display: 'flex', flexWrap: 'wrap', gap: space[2] },
});

const failureMessage: Record<E2eeControlFailure['kind'], string> = {
  network: 'e2ee.control.failure.network',
  auth: 'e2ee.control.failure.auth',
  server: 'e2ee.control.failure.server',
  mode: 'e2ee.control.failure.mode',
  upgrade: 'e2ee.control.failure.upgrade',
  'identity-conflict': 'e2ee.control.failure.identityConflict',
  'progress-conflict': 'e2ee.control.failure.progressConflict',
  'local-corrupt': 'e2ee.control.failure.localCorrupt',
};

function FailurePanel(props: {
  failure: E2eeControlFailure;
  diagnostics: () => string;
  onRepairLocal: () => void;
  onResetProgress: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<'idle' | 'copied' | 'shown'>('idle');
  const [confirmReset, setConfirmReset] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const copy = async () => {
    const text = props.diagnostics();
    setReport(text);
    try {
      await navigator.clipboard.writeText(text);
      setCopied('copied');
    } catch {
      // Clipboard access can be denied; the report stays selectable below.
      setCopied('shown');
    }
  };
  return (
    <div role="alert" {...stylex.props(styles.failure)}>
      <p {...stylex.props(styles.error)}>
        {t(failureMessage[props.failure.kind], { code: props.failure.code })}
      </p>
      <div {...stylex.props(styles.actions)}>
        <Button variant="secondary" onClick={() => void copy()}>
          {copied === 'copied'
            ? t('e2ee.control.diagnosticsCopied')
            : t('e2ee.control.copyDiagnostics')}
        </Button>
        {props.failure.kind === 'local-corrupt' && (
          <Button variant="secondary" onClick={props.onRepairLocal}>
            {t('e2ee.control.repairLocal')}
          </Button>
        )}
        {props.failure.kind === 'progress-conflict' && !confirmReset && (
          <Button variant="ghost" onClick={() => setConfirmReset(true)}>
            {t('e2ee.control.resetProgress')}
          </Button>
        )}
      </div>
      {confirmReset && (
        <div {...stylex.props(styles.failure)}>
          <p {...stylex.props(styles.muted)}>{t('e2ee.control.resetProgressWarning')}</p>
          <div {...stylex.props(styles.actions)}>
            <Button variant="destructive" onClick={props.onResetProgress}>
              {t('e2ee.control.resetProgressConfirm')}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}
      {report !== null && (
        <details open={copied === 'shown'}>
          <summary>{t('e2ee.control.diagnostics')}</summary>
          <p {...stylex.props(styles.muted)}>{t('e2ee.control.diagnosticsHelp')}</p>
          <pre {...stylex.props(styles.raw)}>{report}</pre>
        </details>
      )}
    </div>
  );
}

export interface E2eeWorkspaceControlPageProps {
  workspaceId: string;
  genesisHash?: string;
  history: VerifiedLedgerHistory | null;
  loading: boolean;
  failure: E2eeControlFailure | null;
  unavailable?: boolean;
  /** Builds the support report on demand; it contains no keys or record bodies. */
  diagnostics: () => string;
  /** Deletes only unreadable optional caches, then refreshes. */
  onRepairLocal: () => void;
  /** User-confirmed: forget this device's observed history position, then refresh. */
  onResetProgress: () => void;
  onLoadMore: () => void;
  onRefresh: () => void;
  onBack: () => void;
}

/** Standalone control surface: it never mounts a workspace document or execution runtime. */
export function E2eeWorkspaceControlPage(props: E2eeWorkspaceControlPageProps) {
  const { t } = useTranslation();
  const { history } = props;
  return (
    <main {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.column)}>
        <div>
          <Button variant="ghost" onClick={props.onBack}>
            {t('e2ee.control.back')}
          </Button>
        </div>
        <header>
          <h1 {...stylex.props(styles.title)}>{t('e2ee.control.title')}</h1>
          <p {...stylex.props(styles.muted)}>{t('e2ee.control.description')}</p>
          <div {...stylex.props(styles.badges)}>
            <span {...stylex.props(styles.badge)}>
              <Lock size={14} aria-hidden="true" />
              {t('e2ee.control.badge')}
            </span>
            {history && (
              <span {...stylex.props(styles.badge)}>
                {history.locallyPinned ? (
                  <ShieldCheck size={14} aria-hidden="true" />
                ) : (
                  <ShieldAlert size={14} aria-hidden="true" />
                )}
                {history.locallyPinned
                  ? t('e2ee.control.badgePinned')
                  : t('e2ee.control.badgeUnpinned')}
              </span>
            )}
          </div>
        </header>
        <section {...stylex.props(styles.card)} aria-label={t('e2ee.control.workspace')}>
          <dl {...stylex.props(styles.fields)}>
            <dt>{t('e2ee.control.workspace')}</dt>
            <dd {...stylex.props(styles.value)}>{props.workspaceId}</dd>
            {props.genesisHash && (
              <>
                <dt>{t('e2ee.control.genesis')}</dt>
                <dd {...stylex.props(styles.value)}>{props.genesisHash}</dd>
              </>
            )}
          </dl>
          <p {...stylex.props(styles.notice)}>{t('e2ee.control.contentUnavailable')}</p>
        </section>
        <section aria-label={t('e2ee.control.history')}>
          <div {...stylex.props(styles.heading)}>
            <h2>{t('e2ee.control.history')}</h2>
            <Button variant="secondary" disabled={props.loading} onClick={props.onRefresh}>
              {t('e2ee.control.refresh')}
            </Button>
          </div>
          {history && (
            <div {...stylex.props(styles.muted)}>
              <p>
                {t('e2ee.control.progress', {
                  count: history.view.length,
                  total: history.page.checkpoint.length,
                })}
              </p>
              <p>
                {history.locallyPinned
                  ? t('e2ee.control.verifiedPinned')
                  : t('e2ee.control.verifiedUnpinned')}
              </p>
              {history.continuityPending && <p>{t('e2ee.control.continuityPending')}</p>}
              {history.upgradeRequiredAt !== undefined && (
                <p role="status">
                  {t('e2ee.control.upgradeStop', { position: history.upgradeRequiredAt })}
                </p>
              )}
              <p>{t('e2ee.control.freshness')}</p>
            </div>
          )}
          {props.unavailable && <p role="alert">{t('e2ee.control.unavailable')}</p>}
          {props.failure && (
            <FailurePanel
              failure={props.failure}
              diagnostics={props.diagnostics}
              onRepairLocal={props.onRepairLocal}
              onResetProgress={props.onResetProgress}
            />
          )}
          {props.loading && <p role="status">{t('e2ee.control.loading')}</p>}
          {history && (
            <ol {...stylex.props(styles.records)}>
              {history.records.map((record) => {
                const type =
                  record.body.type === 'genesis' ? 'genesis' : record.body.operation.type;
                return (
                  <li key={record.hash} {...stylex.props(styles.record)}>
                    <h3 {...stylex.props(styles.recordTitle)}>
                      {t('e2ee.control.record', { position: record.index + 1 })} ·{' '}
                      {t(`e2ee.events.${type}`)}
                    </h3>
                    <dl {...stylex.props(styles.fields)}>
                      <dt>{t('e2ee.fields.hash')}</dt>
                      <dd {...stylex.props(styles.value)}>{record.hash}</dd>
                      {Object.entries(ledgerRecordFields(record.body)).map(([key, value]) => (
                        <div key={key} {...stylex.props(styles.fieldPair)}>
                          <dt>{t(`e2ee.fields.${key}`)}</dt>
                          <dd {...stylex.props(styles.value)}>
                            {value === null
                              ? t('e2ee.fields.noExpiry')
                              : key === 'role' || key === 'kind'
                                ? t(`e2ee.values.${value}`)
                                : value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <details>
                      <summary>{t('e2ee.control.raw')}</summary>
                      <pre {...stylex.props(styles.raw)}>{record.rawHex}</pre>
                    </details>
                  </li>
                );
              })}
            </ol>
          )}
          {history?.page.nextCursor && history.upgradeRequiredAt === undefined && (
            <div {...stylex.props(styles.footer)}>
              <Button disabled={props.loading} onClick={props.onLoadMore}>
                {t('e2ee.control.loadMore')}
              </Button>
            </div>
          )}
          {history?.page.nextCursor === null && history.upgradeRequiredAt === undefined && (
            <p>{t('e2ee.control.complete')}</p>
          )}
        </section>
      </div>
    </main>
  );
}

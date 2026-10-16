import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import { useTranslation } from 'react-i18next';
import { ledgerRecordFields, type VerifiedLedgerHistory } from '@/lib/e2ee-ledger-history';

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
});

export interface E2eeWorkspaceControlPageProps {
  workspaceId: string;
  genesisHash?: string;
  history: VerifiedLedgerHistory | null;
  loading: boolean;
  error: boolean;
  unavailable?: boolean;
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
              <p>{t('e2ee.control.freshness')}</p>
            </div>
          )}
          {props.unavailable && <p role="alert">{t('e2ee.control.unavailable')}</p>}
          {props.error && (
            <p role="alert" {...stylex.props(styles.error)}>
              {t('e2ee.control.failed')}
            </p>
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
          {history?.page.nextCursor && (
            <div {...stylex.props(styles.footer)}>
              <Button disabled={props.loading} onClick={props.onLoadMore}>
                {t('e2ee.control.loadMore')}
              </Button>
            </div>
          )}
          {history?.page.nextCursor === null && <p>{t('e2ee.control.complete')}</p>}
        </section>
      </div>
    </main>
  );
}

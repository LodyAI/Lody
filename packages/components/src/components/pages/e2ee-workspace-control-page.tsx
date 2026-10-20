import * as stylex from '@stylexjs/stylex';
import { Accordion } from '@lody/ui/accordion';
import { Alert } from '@lody/ui/alert';
import { Avatar } from '@lody/ui/avatar';
import { Button } from '@lody/ui/button';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft } from 'lucide-react';
import type { TFunction } from 'i18next';
import { ledgerRecordFields, type VerifiedLedgerHistory } from '@/lib/e2ee-ledger-history';
import {
  ledgerOverview,
  shortId,
  type LedgerEventSummary,
  type LedgerMemberLabel,
  type LedgerOverview,
} from '@/lib/e2ee-ledger-overview';
import type { E2eeControlFailure } from '@/lib/e2ee-control-failure';
import { LedgerVerificationCard } from './e2ee-ledger-verification';

const styles = stylex.create({
  page: {
    minHeight: '100vh',
    overflowY: 'auto',
    backgroundColor: colors.background,
    color: colors.label,
    padding: space[6],
  },
  column: {
    maxWidth: 760,
    marginInline: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: space[6],
  },
  titleRow: { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: space[2] },
  title: { fontSize: '1.5em', fontWeight: 600 },
  previewTag: { color: colors.secondaryLabel, fontSize: '0.85em' },
  muted: { color: colors.secondaryLabel, lineHeight: 1.6 },
  footnote: { color: colors.tertiaryLabel, fontSize: '0.85em', lineHeight: 1.6 },
  section: { display: 'flex', flexDirection: 'column', gap: space[3] },
  heading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
  },
  sectionTitle: { fontSize: '1.05em', fontWeight: 600 },
  card: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    borderRadius: radius.large,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.raised,
    overflow: 'hidden',
  },
  memberRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    paddingBlock: space[3],
    paddingInline: space[4],
    borderBottomWidth: { default: 1, ':last-child': 0 },
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
  },
  memberIdentity: { display: 'flex', flexDirection: 'column', minWidth: 0, flexGrow: 1 },
  memberName: {
    fontWeight: 600,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  memberMeta: { color: colors.secondaryLabel, fontSize: '0.85em', whiteSpace: 'nowrap' },
  youTag: { color: colors.secondaryLabel, fontWeight: 400, marginInlineStart: space[1] },
  grow: { flexGrow: 1, minWidth: 0 },
  trailing: {
    color: colors.secondaryLabel,
    fontSize: '0.85em',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  eventRow: { display: 'flex', alignItems: 'baseline', gap: space[3], minWidth: 0 },
  eventIndex: {
    color: colors.tertiaryLabel,
    fontVariantNumeric: 'tabular-nums',
    minWidth: '2ch',
    textAlign: 'end',
  },
  eventText: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'start',
  },
  fields: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(100px, 180px) minmax(0, 1fr)',
      '@media (max-width: 520px)': 'minmax(0, 1fr)',
    },
    columnGap: space[3],
    rowGap: space[2],
    fontSize: '0.9em',
    margin: 0,
  },
  fieldName: { color: colors.secondaryLabel },
  value: { margin: 0, overflowWrap: 'anywhere', fontFamily: 'monospace', userSelect: 'text' },
  fieldPair: { display: 'contents' },
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
  identity: { padding: space[4] },
  panel: { display: 'flex', flexDirection: 'column', gap: space[3] },
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

/** Network and sign-in problems clear on their own; the rest stop verification. */
const failureTone = (kind: E2eeControlFailure['kind']) =>
  kind === 'network' || kind === 'auth' ? 'warning' : 'danger';

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
    <Alert.Root tone={failureTone(props.failure.kind)}>
      <Alert.Title>
        {failureTone(props.failure.kind) === 'warning'
          ? t('e2ee.control.status.unreachable')
          : t('e2ee.control.status.stopped')}
      </Alert.Title>
      <Alert.Description>
        {t(failureMessage[props.failure.kind], { code: props.failure.code })}
      </Alert.Description>
      {confirmReset && (
        <Alert.Description>{t('e2ee.control.resetProgressWarning')}</Alert.Description>
      )}
      <Alert.Actions>
        {confirmReset ? (
          <>
            <Button variant="destructive" onClick={props.onResetProgress}>
              {t('e2ee.control.resetProgressConfirm')}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          <>
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
            {props.failure.kind === 'progress-conflict' && (
              <Button variant="ghost" onClick={() => setConfirmReset(true)}>
                {t('e2ee.control.resetProgress')}
              </Button>
            )}
          </>
        )}
      </Alert.Actions>
      {report !== null && (
        <details open={copied === 'shown'}>
          <summary>{t('e2ee.control.diagnostics')}</summary>
          <p {...stylex.props(styles.muted)}>{t('e2ee.control.diagnosticsHelp')}</p>
          <pre {...stylex.props(styles.raw)}>{report}</pre>
        </details>
      )}
    </Alert.Root>
  );
}

/** Display identity for a member. Names come from account profiles, never from the ledger. */
export interface E2eeMemberProfile {
  name: string;
  image?: string | null;
}

type ResolveMember = (member: LedgerMemberLabel | null) => string;

function useMemberNames(
  history: VerifiedLedgerHistory | null,
  overview: LedgerOverview | null,
  profiles: ReadonlyMap<string, E2eeMemberProfile> | undefined,
  you: E2eeMemberProfile | undefined
) {
  const { t } = useTranslation();
  return useMemo(() => {
    const merged = new Map(profiles);
    let self: string | null = null;
    // Only a creation pin on this device ties the genesis member to this account.
    const genesis = overview?.events[0];
    if (history?.locallyPinned === true && you && genesis?.type === 'genesis') {
      self = genesis.actor.membershipId;
      merged.set(self, you);
    }
    const fallback = (member: LedgerMemberLabel) =>
      member.ordinal === null
        ? t('e2ee.summary.memberById', { id: shortId(member.membershipId) })
        : t('e2ee.summary.member', { number: member.ordinal });
    const name: ResolveMember = (member) =>
      member === null
        ? t('e2ee.summary.unknownSigner')
        : (merged.get(member.membershipId)?.name ?? fallback(member));
    return { name, profile: (id: string) => merged.get(id), self, fallback };
  }, [history, overview, profiles, you, t]);
}

function eventSentence(t: TFunction, name: ResolveMember, event: LedgerEventSummary): string {
  const actor = name(event.actor);
  switch (event.type) {
    case 'genesis':
      return t('e2ee.summary.genesis', { actor });
    case 'admitMember':
      return t('e2ee.summary.admitMember', { actor, member: name(event.member) });
    case 'setRole':
      return t('e2ee.summary.setRole', {
        actor,
        member: name(event.member),
        role: t(`e2ee.values.${event.role}`),
      });
    case 'admitDevice':
      return t('e2ee.summary.admitDevice', {
        actor,
        device: shortId(event.device),
        kind: t(`e2ee.values.${event.kind}`),
      });
    case 'revokeDevice':
      return event.owner === null
        ? t('e2ee.summary.revokeUnknownDevice', { actor, device: shortId(event.device) })
        : t('e2ee.summary.revokeDevice', {
            actor,
            owner: name(event.owner),
            device: shortId(event.device),
          });
    case 'transferOwner':
      return t('e2ee.summary.transferOwner', { actor, member: name(event.member) });
    case 'publishEpoch':
      return t('e2ee.summary.publishEpoch', { actor, epoch: event.epoch });
    case 'removeMemberAndPublishEpoch':
      return t('e2ee.summary.removeMemberAndPublishEpoch', {
        actor,
        member: name(event.member),
        epoch: event.epoch,
      });
    case 'declareCapabilities':
    default:
      return t('e2ee.summary.declareCapabilities', { actor, capabilities: event.capabilities });
  }
}

function MembersSection(props: {
  history: VerifiedLedgerHistory;
  overview: LedgerOverview;
  names: ReturnType<typeof useMemberNames>;
}) {
  const { t } = useTranslation();
  const { names } = props;
  const partial = props.history.view.length < props.history.page.checkpoint.length;
  return (
    <section aria-label={t('e2ee.control.members')} {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.heading)}>
        <h2 {...stylex.props(styles.sectionTitle)}>{t('e2ee.control.members')}</h2>
        {partial && (
          <span {...stylex.props(styles.footnote)}>
            {t('e2ee.control.membersAsOf', { count: props.history.view.length })}
          </span>
        )}
      </div>
      <ul {...stylex.props(styles.card)}>
        {props.overview.members.map((member) => {
          const profile = names.profile(member.membershipId);
          const name = names.name(member);
          return (
            <li key={member.membershipId} {...stylex.props(styles.memberRow)}>
              <Avatar.Root size="large">
                {profile?.image != null && profile.image !== '' ? (
                  <Avatar.Image src={profile.image} alt="" />
                ) : null}
                <Avatar.Fallback>
                  {profile ? name.slice(0, 1).toUpperCase() : (member.ordinal ?? '?')}
                </Avatar.Fallback>
              </Avatar.Root>
              <span {...stylex.props(styles.memberIdentity)}>
                <span {...stylex.props(styles.memberName)}>
                  {name}
                  {names.self === member.membershipId && (
                    <span {...stylex.props(styles.youTag)}>{t('e2ee.control.you')}</span>
                  )}
                </span>
                <span {...stylex.props(styles.memberMeta)}>
                  {[
                    t(`e2ee.values.${member.role}`),
                    ...(profile ? [names.fallback(member)] : []),
                  ].join(' · ')}
                </span>
              </span>
              <span {...stylex.props(styles.trailing)}>
                {member.devices.length === 0
                  ? t('e2ee.control.noDevices')
                  : member.devices
                      .map(
                        (device) => `${shortId(device.key)} · ${t(`e2ee.values.${device.kind}`)}`
                      )
                      .join(', ')}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export interface E2eeWorkspaceControlPageProps {
  workspaceId: string;
  genesisHash?: string;
  history: VerifiedLedgerHistory | null;
  loading: boolean;
  failure: E2eeControlFailure | null;
  unavailable?: boolean;
  /** The signed-in account; shown on the genesis member only when this device holds the creation pin. */
  you?: E2eeMemberProfile;
  /** Server-provided display profiles by membership ID. Display only: verify with the ledger code. */
  memberProfiles?: ReadonlyMap<string, E2eeMemberProfile>;
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
  const overview = useMemo(() => (history ? ledgerOverview(history) : null), [history]);
  const names = useMemberNames(history, overview, props.memberProfiles, props.you);
  return (
    <main {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.column)}>
        <div>
          <Button variant="ghost" onClick={props.onBack}>
            <ChevronLeft size={16} aria-hidden="true" />
            {t('e2ee.control.back')}
          </Button>
        </div>
        <header>
          <div {...stylex.props(styles.titleRow)}>
            <h1 {...stylex.props(styles.title)}>{t('e2ee.control.title')}</h1>
            <span {...stylex.props(styles.previewTag)}>{t('e2ee.control.badge')}</span>
          </div>
          <p {...stylex.props(styles.muted)}>{t('e2ee.control.description')}</p>
          <p {...stylex.props(styles.footnote)}>{t('e2ee.control.contentUnavailable')}</p>
        </header>
        {props.unavailable === true && (
          <Alert.Root tone="neutral">
            <Alert.Description>{t('e2ee.control.unavailable')}</Alert.Description>
          </Alert.Root>
        )}
        {props.failure && (
          <FailurePanel
            failure={props.failure}
            diagnostics={props.diagnostics}
            onRepairLocal={props.onRepairLocal}
            onResetProgress={props.onResetProgress}
          />
        )}
        {history?.upgradeRequiredAt !== undefined && (
          <Alert.Root tone="warning">
            <Alert.Title>{t('e2ee.control.status.upgrade')}</Alert.Title>
            <Alert.Description>
              {t('e2ee.control.upgradeStop', { position: history.upgradeRequiredAt })}
            </Alert.Description>
          </Alert.Root>
        )}
        {history && overview && (
          <LedgerVerificationCard
            history={history}
            stats={[
              t('e2ee.control.memberCount', { count: overview.members.length }),
              t('e2ee.control.deviceCount', { count: overview.deviceCount }),
              t('e2ee.control.epoch', { epoch: overview.epoch.number }),
            ].join(' · ')}
            actions={
              <Button variant="ghost" disabled={props.loading} onClick={props.onRefresh}>
                {t('e2ee.control.refresh')}
              </Button>
            }
          />
        )}
        {history && history.view.length < history.page.checkpoint.length && (
          <p {...stylex.props(styles.footnote)}>
            {t('e2ee.control.progress', {
              count: history.view.length,
              total: history.page.checkpoint.length,
            })}
          </p>
        )}
        {history?.continuityPending === true && (
          <p {...stylex.props(styles.footnote)}>{t('e2ee.control.continuityPending')}</p>
        )}
        {props.loading && (
          <p role="status" {...stylex.props(styles.muted)}>
            {t('e2ee.control.loading')}
          </p>
        )}
        {history && overview && (
          <MembersSection history={history} overview={overview} names={names} />
        )}
        {history && overview && (
          <section aria-label={t('e2ee.control.history')} {...stylex.props(styles.section)}>
            <h2 {...stylex.props(styles.sectionTitle)}>{t('e2ee.control.history')}</h2>
            <Accordion.Root multiple>
              {history.records.map((record, position) => {
                const event = overview.events[position];
                return (
                  <Accordion.Item key={record.hash} value={record.hash}>
                    <Accordion.Trigger>
                      <span {...stylex.props(styles.eventRow)}>
                        <span {...stylex.props(styles.eventIndex)}>{record.index + 1}</span>
                        <span {...stylex.props(styles.eventText)}>
                          {eventSentence(t, names.name, event)}
                        </span>
                      </span>
                    </Accordion.Trigger>
                    <Accordion.Panel>
                      <div {...stylex.props(styles.panel)}>
                        <dl {...stylex.props(styles.fields)}>
                          <dt {...stylex.props(styles.fieldName)}>{t('e2ee.control.operation')}</dt>
                          <dd {...stylex.props(styles.value)}>{t(`e2ee.events.${event.type}`)}</dd>
                          <dt {...stylex.props(styles.fieldName)}>{t('e2ee.fields.hash')}</dt>
                          <dd {...stylex.props(styles.value)}>{record.hash}</dd>
                          {Object.entries(ledgerRecordFields(record.body)).map(([key, value]) => (
                            <div key={key} {...stylex.props(styles.fieldPair)}>
                              <dt {...stylex.props(styles.fieldName)}>{t(`e2ee.fields.${key}`)}</dt>
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
                      </div>
                    </Accordion.Panel>
                  </Accordion.Item>
                );
              })}
            </Accordion.Root>
            {history.page.nextCursor !== null && history.upgradeRequiredAt === undefined && (
              <div>
                <Button disabled={props.loading} onClick={props.onLoadMore}>
                  {t('e2ee.control.loadMore')}
                </Button>
              </div>
            )}
            {history.page.nextCursor === null && history.upgradeRequiredAt === undefined && (
              <p {...stylex.props(styles.footnote)}>{t('e2ee.control.complete')}</p>
            )}
          </section>
        )}
        <section aria-label={t('e2ee.control.identity')} {...stylex.props(styles.section)}>
          <h2 {...stylex.props(styles.sectionTitle)}>{t('e2ee.control.identity')}</h2>
          <div {...stylex.props(styles.card, styles.identity)}>
            <dl {...stylex.props(styles.fields)}>
              <dt {...stylex.props(styles.fieldName)}>{t('e2ee.control.workspace')}</dt>
              <dd {...stylex.props(styles.value)}>{props.workspaceId}</dd>
              {props.genesisHash !== undefined && (
                <>
                  <dt {...stylex.props(styles.fieldName)}>{t('e2ee.control.genesis')}</dt>
                  <dd {...stylex.props(styles.value)}>{props.genesisHash}</dd>
                </>
              )}
            </dl>
          </div>
        </section>
      </div>
    </main>
  );
}

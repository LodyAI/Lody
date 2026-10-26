import * as stylex from '@stylexjs/stylex';
import { Accordion } from '@lody/ui/accordion';
import { Alert } from '@lody/ui/alert';
import { Avatar } from '@lody/ui/avatar';
import { Button } from '@lody/ui/button';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text as type } from '@lody/ui/tokens/scales.stylex';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, CircleHelp, RefreshCw } from 'lucide-react';
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

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const styles = stylex.create({
  page: {
    minHeight: '100vh',
    overflowY: 'auto',
    backgroundColor: colors.background,
    color: colors.label,
    paddingBlock: space[6],
    paddingInline: { default: space[6], '@media (max-width: 520px)': space[4] },
    fontSize: type.bodySize,
    lineHeight: 1.45,
  },
  column: {
    maxWidth: 600,
    marginInline: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: space[6],
  },
  back: { marginInlineStart: `calc(-1 * ${space[2]})`, alignSelf: 'flex-start' },
  header: { display: 'flex', alignItems: 'center', gap: space[2] },
  titleBlock: { flexGrow: 1, minWidth: 0 },
  title: { fontSize: type.titleSize, lineHeight: type.titleLeading, fontWeight: 600, margin: 0 },
  preview: { fontSize: type.footnoteSize, color: colors.tertiaryLabel },
  help: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    padding: space[4],
    borderRadius: radius.large,
    backgroundColor: colors.secondaryBackground,
    color: colors.secondaryLabel,
    fontSize: type.subheadlineSize,
    lineHeight: 1.6,
  },
  helpIds: {
    display: 'grid',
    gridTemplateColumns: 'max-content minmax(0, 1fr)',
    columnGap: space[3],
    rowGap: space[1],
    marginTop: space[2],
    fontSize: type.footnoteSize,
  },
  id: {
    margin: 0,
    fontFamily: MONO,
    color: colors.secondaryLabel,
    overflowWrap: 'anywhere',
    userSelect: 'text',
  },
  section: { display: 'flex', flexDirection: 'column', gap: space[2] },
  sectionHeading: {
    display: 'flex',
    alignItems: 'baseline',
    gap: space[2],
    paddingInline: space[1],
    fontSize: type.subheadlineSize,
    fontWeight: 500,
    color: colors.secondaryLabel,
    margin: 0,
  },
  count: { color: colors.tertiaryLabel, fontWeight: 400 },
  list: {
    listStyle: 'none',
    margin: 0,
    paddingBlock: space[1],
    paddingInline: space[4],
    borderRadius: radius.large,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
  },
  memberRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    minHeight: 44,
    borderBottomWidth: { default: 1, ':last-child': 0 },
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
  },
  memberName: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 500,
  },
  you: { color: colors.tertiaryLabel, fontWeight: 400, marginInlineStart: space[1.5] },
  memberRole: {
    width: '5em',
    color: colors.secondaryLabel,
    fontSize: type.subheadlineSize,
    whiteSpace: 'nowrap',
  },
  memberDevices: {
    minWidth: '4.5em',
    textAlign: 'end',
    color: colors.tertiaryLabel,
    fontSize: type.footnoteSize,
    whiteSpace: 'nowrap',
  },
  history: {
    paddingInline: space[4],
    borderRadius: radius.large,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
  },
  eventRow: { display: 'flex', alignItems: 'baseline', gap: space[3], minWidth: 0 },
  eventIndex: {
    color: colors.tertiaryLabel,
    fontSize: type.footnoteSize,
    fontVariantNumeric: 'tabular-nums',
    minWidth: '1.6em',
  },
  eventText: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'start',
    fontWeight: 400,
  },
  fields: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(96px, max-content) minmax(0, 1fr)',
      '@media (max-width: 520px)': 'minmax(0, 1fr)',
    },
    columnGap: space[4],
    rowGap: space[1.5],
    alignItems: 'baseline',
    margin: 0,
    fontSize: type.footnoteSize,
  },
  fieldName: { color: colors.tertiaryLabel },
  value: {
    margin: 0,
    overflowWrap: 'anywhere',
    fontFamily: MONO,
    fontSize: type.captionSize,
    lineHeight: type.footnoteLeading,
    userSelect: 'text',
  },
  fieldPair: { display: 'contents' },
  raw: {
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    padding: space[3],
    marginTop: space[2],
    borderRadius: radius.small,
    backgroundColor: colors.secondaryBackground,
    fontFamily: MONO,
    fontSize: type.captionSize,
    color: colors.secondaryLabel,
  },
  rawToggle: { color: colors.tertiaryLabel, fontSize: type.footnoteSize, cursor: 'pointer' },
  panel: { display: 'flex', flexDirection: 'column', gap: space[3], paddingBottom: space[2] },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    paddingInline: space[1],
    color: colors.tertiaryLabel,
    fontSize: type.footnoteSize,
  },
  quiet: { color: colors.tertiaryLabel, fontSize: type.footnoteSize },
  muted: { color: colors.secondaryLabel },
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
  overview: LedgerOverview;
  names: ReturnType<typeof useMemberNames>;
}) {
  const { t } = useTranslation();
  const { names } = props;
  return (
    <section aria-label={t('e2ee.control.members')} {...stylex.props(styles.section)}>
      <h2 {...stylex.props(styles.sectionHeading)}>
        {t('e2ee.control.members')}
        <span {...stylex.props(styles.count)}>{props.overview.members.length}</span>
      </h2>
      <ul {...stylex.props(styles.list)}>
        {props.overview.members.map((member) => {
          const profile = names.profile(member.membershipId);
          const name = names.name(member);
          return (
            <li key={member.membershipId} {...stylex.props(styles.memberRow)}>
              <Avatar.Root size="medium">
                {profile?.image != null && profile.image !== '' ? (
                  <Avatar.Image src={profile.image} alt="" />
                ) : null}
                <Avatar.Fallback>
                  {profile ? name.slice(0, 1).toUpperCase() : (member.ordinal ?? '?')}
                </Avatar.Fallback>
              </Avatar.Root>
              <span {...stylex.props(styles.memberName)}>
                {name}
                {names.self === member.membershipId && (
                  <span {...stylex.props(styles.you)}>{t('e2ee.control.you')}</span>
                )}
              </span>
              <span {...stylex.props(styles.memberRole)}>{t(`e2ee.values.${member.role}`)}</span>
              <span
                title={member.devices
                  .map((device) => `${shortId(device.key)} · ${t(`e2ee.values.${device.kind}`)}`)
                  .join('\n')}
                {...stylex.props(styles.memberDevices)}
              >
                {t('e2ee.control.deviceCount', { count: member.devices.length })}
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
  /** Optional host-backed developer controls; no cryptographic work in this surface. */
  children?: ReactNode;
}

/** Standalone control surface: it never mounts a workspace document or execution runtime. */
export function E2eeWorkspaceControlPage(props: E2eeWorkspaceControlPageProps) {
  const { t } = useTranslation();
  const { history } = props;
  const overview = useMemo(() => (history ? ledgerOverview(history) : null), [history]);
  const names = useMemberNames(history, overview, props.memberProfiles, props.you);
  const [helpOpen, setHelpOpen] = useState(false);
  const total = history?.page.checkpoint.length ?? 0;
  return (
    <main {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.column)}>
        <Button variant="ghost" size="small" onClick={props.onBack} {...stylex.props(styles.back)}>
          <ChevronLeft size={14} aria-hidden="true" />
          {t('e2ee.control.back')}
        </Button>
        <header {...stylex.props(styles.header)}>
          <div {...stylex.props(styles.titleBlock)}>
            <h1 {...stylex.props(styles.title)}>{t('e2ee.control.title')}</h1>
            <span {...stylex.props(styles.preview)}>{t('e2ee.control.badge')}</span>
          </div>
          <Button
            variant="ghost"
            icon
            aria-label={t('e2ee.control.refresh')}
            title={t('e2ee.control.refresh')}
            disabled={props.loading}
            onClick={props.onRefresh}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            icon
            aria-label={t('e2ee.control.help')}
            aria-expanded={helpOpen}
            title={t('e2ee.control.help')}
            onClick={() => setHelpOpen((open) => !open)}
          >
            <CircleHelp size={16} aria-hidden="true" />
          </Button>
        </header>
        {helpOpen && (
          <div {...stylex.props(styles.help)}>
            <p>{t('e2ee.verify.hint')}</p>
            <p>{t('e2ee.verify.hintCaveat')}</p>
            <p>{t('e2ee.control.contentUnavailable')}</p>
            <dl {...stylex.props(styles.helpIds)}>
              <dt>{t('e2ee.control.workspace')}</dt>
              <dd {...stylex.props(styles.id)}>{props.workspaceId}</dd>
              {props.genesisHash !== undefined && (
                <>
                  <dt>{t('e2ee.control.genesis')}</dt>
                  <dd {...stylex.props(styles.id)}>{props.genesisHash}</dd>
                </>
              )}
            </dl>
          </div>
        )}
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
            <Alert.Description>
              {t('e2ee.control.upgradeStop', { position: history.upgradeRequiredAt })}
            </Alert.Description>
          </Alert.Root>
        )}
        {props.loading && !history && (
          <p role="status" {...stylex.props(styles.quiet)}>
            {t('e2ee.control.loading')}
          </p>
        )}
        {history && <LedgerVerificationCard history={history} />}
        {props.children}
        {history && overview && <MembersSection overview={overview} names={names} />}
        {history && overview && (
          <section aria-label={t('e2ee.control.history')} {...stylex.props(styles.section)}>
            <h2 {...stylex.props(styles.sectionHeading)}>
              {t('e2ee.control.history')}
              <span {...stylex.props(styles.count)}>
                {history.view.length < total ? `${history.view.length} / ${total}` : total}
              </span>
            </h2>
            <div {...stylex.props(styles.history)}>
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
                            <dt {...stylex.props(styles.fieldName)}>
                              {t('e2ee.control.operation')}
                            </dt>
                            <dd {...stylex.props(styles.muted)}>
                              {t(`e2ee.events.${event.type}`)}
                            </dd>
                            <dt {...stylex.props(styles.fieldName)}>{t('e2ee.fields.hash')}</dt>
                            <dd {...stylex.props(styles.value)}>{record.hash}</dd>
                            {Object.entries(ledgerRecordFields(record.body)).map(([key, value]) => (
                              <div key={key} {...stylex.props(styles.fieldPair)}>
                                <dt {...stylex.props(styles.fieldName)}>
                                  {t(`e2ee.fields.${key}`)}
                                </dt>
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
                            <summary {...stylex.props(styles.rawToggle)}>
                              {t('e2ee.control.raw')}
                            </summary>
                            <pre {...stylex.props(styles.raw)}>{record.rawHex}</pre>
                          </details>
                        </div>
                      </Accordion.Panel>
                    </Accordion.Item>
                  );
                })}
              </Accordion.Root>
            </div>
            {history.page.nextCursor !== null && history.upgradeRequiredAt === undefined && (
              <div {...stylex.props(styles.footer)}>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={props.loading}
                  onClick={props.onLoadMore}
                >
                  {t('e2ee.control.loadMore')}
                </Button>
                {history.continuityPending && <span>{t('e2ee.control.continuityPending')}</span>}
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

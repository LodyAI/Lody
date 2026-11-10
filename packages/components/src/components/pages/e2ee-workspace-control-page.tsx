import { E2eeMemberActions, type E2eeMemberManagement } from './e2ee-member-actions';
import * as stylex from '@stylexjs/stylex';
import { Accordion } from '@lody/ui/accordion';
import { Alert } from '@lody/ui/alert';
import { Avatar } from '@lody/ui/avatar';
import { Button } from '@lody/ui/button';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text as type } from '@lody/ui/tokens/scales.stylex';
import { Children, Fragment, isValidElement, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronLeft,
  CircleHelp,
  LayoutDashboard,
  LifeBuoy,
  Lock,
  MonitorSmartphone,
  RefreshCw,
  ShieldCheck,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { TFunction } from 'i18next';
import { ledgerRecordFields, type VerifiedLedgerHistory } from '@/lib/e2ee-ledger-history';
import {
  ledgerOverview,
  shortId,
  type LedgerEventSummary,
  type LedgerMemberLabel,
  type LedgerOverview,
} from '@/lib/e2ee-ledger-overview';
import { custodyFailureMessages, type E2eeControlFailure } from '@/lib/e2ee-control-failure';
import { LedgerVerificationCard } from './e2ee-ledger-verification';
import {
  E2EE_CONSOLE_TABS,
  E2eeConsoleSection,
  type E2eeConsoleTab,
} from '@/components/pages/e2ee-console-section';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const styles = stylex.create({
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
  // Console frame: the same layout as a page and inside the Settings dialog.
  consolePage: {
    boxSizing: 'border-box',
    height: { default: '100vh', '@supports (height: 100dvh)': '100dvh' },
    backgroundColor: colors.background,
    color: colors.label,
    paddingTop: {
      default: `max(${space[6]}, env(safe-area-inset-top))`,
      '@media (max-width: 720px)': 'env(safe-area-inset-top)',
    },
    paddingBottom: {
      default: `max(${space[6]}, env(safe-area-inset-bottom))`,
      '@media (max-width: 720px)': 'env(safe-area-inset-bottom)',
    },
    paddingInline: { default: space[6], '@media (max-width: 720px)': 0 },
    display: 'flex',
    justifyContent: 'center',
    fontSize: type.bodySize,
    lineHeight: 1.45,
  },
  consoleFrame: {
    display: 'grid',
    gridTemplateColumns: {
      default: '220px minmax(0, 1fr)',
      '@media (max-width: 720px)': 'minmax(0, 1fr)',
    },
    gridTemplateRows: {
      default: 'minmax(0, 1fr)',
      '@media (max-width: 720px)': 'auto minmax(0, 1fr)',
    },
    width: '100%',
    maxWidth: 1000,
    height: '100%',
    minHeight: 0,
    overflow: 'hidden',
    color: colors.label,
    fontSize: type.bodySize,
    lineHeight: 1.45,
  },
  consoleFramePage: {
    borderRadius: { default: radius.large, '@media (max-width: 720px)': 0 },
    backgroundColor: colors.background,
    boxShadow: { default: shadow.card, '@media (max-width: 720px)': 'none' },
  },
  nav: {
    display: 'flex',
    flexDirection: { default: 'column', '@media (max-width: 720px)': 'row' },
    gap: space[1],
    padding: { default: space[3], '@media (max-width: 720px)': `${space[2]} ${space[3]}` },
    backgroundColor: colors.secondaryBackground,
    overflowX: { default: 'visible', '@media (max-width: 720px)': 'auto' },
  },
  navIdentity: {
    display: { default: 'flex', '@media (max-width: 720px)': 'none' },
    alignItems: 'center',
    gap: space[2],
    paddingInline: space[2],
    paddingBottom: space[3],
    minWidth: 0,
  },
  navName: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  navLock: { flexShrink: 0, color: colors.secondaryLabel },
  navItem: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    flexShrink: 0,
    paddingBlock: space[1.5],
    paddingInline: space[3],
    borderRadius: radius.medium,
    borderWidth: 0,
    backgroundColor: { default: 'transparent', ':hover': colors.wellBackground },
    color: colors.label,
    font: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  navItemActive: { backgroundColor: colors.wellBackground, fontWeight: 600 },
  navBadge: {
    marginInlineStart: 'auto',
    minWidth: 18,
    height: 18,
    paddingInline: 5,
    borderRadius: 9,
    backgroundColor: colors.destructive,
    color: '#ffffff',
    fontSize: 11,
    fontWeight: 700,
    display: 'inline-grid',
    placeItems: 'center',
  },
  main: { display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 },
  mainHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    paddingBlock: space[4],
    paddingInline: { default: space[6], '@media (max-width: 720px)': space[4] },
  },
  mainTitle: {
    margin: 0,
    fontSize: type.titleSize,
    lineHeight: type.titleLeading,
    fontWeight: 600,
    flexGrow: 1,
    minWidth: 0,
  },
  mainBody: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingInline: { default: space[6], '@media (max-width: 720px)': space[4] },
    paddingBottom: space[6],
    display: 'flex',
    flexDirection: 'column',
    gap: space[6],
  },
  hero: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    padding: space[4],
    borderRadius: radius.large,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
  },
  heroGlyph: {
    display: 'inline-grid',
    placeItems: 'center',
    flexShrink: 0,
    width: 36,
    height: 36,
    borderRadius: radius.medium,
    backgroundColor: colors.secondaryBackground,
    color: colors.success,
  },
  heroText: { display: 'flex', flexDirection: 'column', minWidth: 0, flexGrow: 1 },
  heroTitle: { fontWeight: 600 },
  heroHelp: { color: colors.secondaryLabel, fontSize: type.subheadlineSize },
  quick: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'repeat(4, minmax(0, 1fr))',
      '@media (max-width: 720px)': 'repeat(2, minmax(0, 1fr))',
    },
    gap: space[2],
  },
  quickItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space[2],
    padding: space[3],
    borderRadius: radius.large,
    borderWidth: 0,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
    color: colors.label,
    font: 'inherit',
    fontWeight: 500,
    textAlign: 'start',
    cursor: 'pointer',
  },
  quickIcon: { color: colors.secondaryLabel },
  checkMark: {
    display: 'inline-grid',
    placeItems: 'center',
    flexShrink: 0,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderStyle: 'solid',
    borderColor: colors.separator,
    color: '#ffffff',
  },
  checkMarkDone: { borderColor: colors.success, backgroundColor: colors.success },
  checkDoneText: { color: colors.secondaryLabel },
  linkButton: {
    marginInlineStart: 'auto',
    borderWidth: 0,
    padding: 0,
    background: 'none',
    color: colors.secondaryLabel,
    font: 'inherit',
    fontSize: type.footnoteSize,
    fontWeight: 400,
    cursor: 'pointer',
  },
});

const TAB_ICONS: Record<E2eeConsoleTab, LucideIcon> = {
  overview: LayoutDashboard,
  members: Users,
  devices: MonitorSmartphone,
  security: ShieldCheck,
  recovery: LifeBuoy,
};

/** Splits host children by their `E2eeConsoleSection` tab; unmarked children stay on Overview. */
function sectionsByTab(children: ReactNode) {
  const byTab = new Map<E2eeConsoleTab, ReactNode[]>();
  const visit = (nodes: ReactNode) =>
    Children.forEach(nodes, (child) => {
      if (child === null || child === undefined || child === false) return;
      // Hosts group sections in fragments; React does not flatten those for us.
      if (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment) {
        visit(child.props.children);
        return;
      }
      place(child);
    });
  const place = (child: ReactNode) => {
    const tab =
      isValidElement<{ tab?: E2eeConsoleTab }>(child) && child.type === E2eeConsoleSection
        ? (child.props.tab ?? 'overview')
        : 'overview';
    byTab.set(tab, [...(byTab.get(tab) ?? []), child]);
  };
  visit(children);
  return byTab;
}

type FailureAction = 'refresh' | 'devices' | 'recovery' | 'security' | 'repair' | 'update';

/** One card per failure: a conclusion, one reason that says what is still safe, and
 * the single next step. Diagnostics stay available but secondary. */
const failureCards: Record<
  E2eeControlFailure['kind'],
  { title: string; body: string; action?: FailureAction; secondary?: FailureAction }
> = {
  'approval-required': {
    title: 'e2ee.pair.desktopApprovalRequired',
    body: 'e2ee.pair.help',
    action: 'devices',
  },
  'local-identity': {
    title: 'e2ee.failure.identity.title',
    body: 'e2ee.failure.identity.body',
    action: 'devices',
    secondary: 'recovery',
  },
  'custody-locked': {
    title: 'e2ee.custody.locked.title',
    body: custodyFailureMessages['custody-locked'],
    action: 'refresh',
  },
  'custody-indeterminate': {
    title: 'e2ee.custody.indeterminate.title',
    body: custodyFailureMessages['custody-indeterminate'],
    action: 'refresh',
  },
  'custody-unavailable': {
    title: 'e2ee.custody.unavailable.title',
    body: custodyFailureMessages['custody-unavailable'],
    action: 'update',
  },
  network: {
    title: 'e2ee.control.status.unreachable',
    body: 'e2ee.control.failure.network',
    action: 'refresh',
  },
  auth: { title: 'e2ee.failure.auth.title', body: 'e2ee.control.failure.auth' },
  server: {
    title: 'e2ee.failure.server.title',
    body: 'e2ee.control.failure.server',
    action: 'refresh',
  },
  mode: {
    title: 'e2ee.control.status.stopped',
    body: 'e2ee.control.failure.mode',
    action: 'refresh',
  },
  upgrade: {
    title: 'e2ee.failure.upgrade.title',
    body: 'e2ee.control.failure.upgrade',
    action: 'update',
  },
  'identity-conflict': {
    title: 'e2ee.failure.identityConflict.title',
    body: 'e2ee.control.failure.identityConflict',
    action: 'security',
  },
  'progress-conflict': {
    title: 'e2ee.failure.progressConflict.title',
    body: 'e2ee.control.failure.progressConflict',
  },
  'local-corrupt': {
    title: 'e2ee.failure.localCorrupt.title',
    body: 'e2ee.control.failure.localCorrupt',
    action: 'repair',
  },
};

const failureActionLabel: Record<FailureAction, string> = {
  refresh: 'e2ee.failure.action.refresh',
  devices: 'e2ee.failure.action.devices',
  recovery: 'e2ee.failure.action.recovery',
  security: 'e2ee.failure.action.security',
  repair: 'e2ee.control.repairLocal',
  update: 'e2ee.failure.action.update',
};

/** Network and sign-in problems clear on their own; the rest stop verification. */
const failureTone = (kind: E2eeControlFailure['kind']) =>
  kind === 'network' || kind === 'auth' || kind === 'approval-required' || kind === 'custody-locked'
    ? 'warning'
    : 'danger';

function FailurePanel(props: {
  failure: E2eeControlFailure;
  diagnostics: () => string;
  onRepairLocal: () => void;
  onResetProgress: () => void;
  onRefresh: () => void;
  onNavigate: (tab: E2eeConsoleTab) => void;
  /** Absent where the host cannot check for app updates; the card then has no update button. */
  onCheckForUpdates?: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<'idle' | 'copied' | 'shown'>('idle');
  const [confirmReset, setConfirmReset] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const card = failureCards[props.failure.kind];
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
  const handlers: Record<FailureAction, (() => void) | undefined> = {
    refresh: props.onRefresh,
    devices: () => props.onNavigate('devices'),
    recovery: () => props.onNavigate('recovery'),
    security: () => props.onNavigate('security'),
    repair: props.onRepairLocal,
    update: props.onCheckForUpdates,
  };
  // Only actions that do something are shown.
  const actionButton = (action: FailureAction | undefined, variant: 'primary' | 'secondary') => {
    const run = action ? handlers[action] : undefined;
    return action && run ? (
      <Button variant={variant} data-failure-action={action} onClick={run}>
        {t(failureActionLabel[action])}
      </Button>
    ) : null;
  };
  return (
    <Alert.Root tone={failureTone(props.failure.kind)} data-failure-kind={props.failure.kind}>
      <Alert.Title>{t(card.title)}</Alert.Title>
      <Alert.Description>{t(card.body, { code: props.failure.code })}</Alert.Description>
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
            {actionButton(card.action, 'primary')}
            {actionButton(card.secondary, 'secondary')}
            <Button
              variant={card.action && handlers[card.action] ? 'ghost' : 'secondary'}
              onClick={() => void copy()}
            >
              {copied === 'copied'
                ? t('e2ee.control.diagnosticsCopied')
                : t('e2ee.control.copyDiagnostics')}
            </Button>
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
    const merged = new Map<string, E2eeMemberProfile>();
    for (const member of overview?.members ?? []) {
      const profile = profiles?.get(member.userId);
      if (profile) merged.set(member.membershipId, profile);
    }
    let self: string | null = null;
    // Only a creation pin on this device ties the genesis member to this account.
    const genesis = overview?.events[0];
    if (
      profiles === undefined &&
      history?.locallyPinned === true &&
      you &&
      genesis?.type === 'genesis'
    ) {
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
    case 'removeMember':
      return t('e2ee.summary.removeMember', { actor, member: name(event.member) });
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
  management?: E2eeMemberManagement;
}) {
  const { t } = useTranslation();
  const { names } = props;
  return (
    <section
      data-testid="e2ee-members"
      aria-label={t('e2ee.control.members')}
      {...stylex.props(styles.section)}
    >
      <h2 {...stylex.props(styles.sectionHeading)}>
        {t('e2ee.control.members')}
        <span {...stylex.props(styles.count)}>{props.overview.members.length}</span>
      </h2>
      <ul {...stylex.props(styles.list)}>
        {props.overview.members.map((member) => {
          const profile = names.profile(member.membershipId);
          const name = names.name(member);
          return (
            <li
              data-testid="e2ee-member"
              data-membership-id={member.membershipId}
              key={member.membershipId}
              {...stylex.props(styles.memberRow)}
            >
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
              {props.management && (
                <E2eeMemberActions member={member} name={name} management={props.management} />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export interface E2eeWorkspaceControlPageProps {
  memberManagement?: E2eeMemberManagement;
  workspaceId: string;
  /** Display name for the title; the ledger never carries one. */
  workspaceName?: string;
  /** `page` fills the window; `modal` fills the Settings dialog that hosts it. */
  presentation?: 'page' | 'modal';
  initialTab?: E2eeConsoleTab;
  /** This device's verified role, when the host has opened it. Display only. */
  memberRole?: 'owner' | 'admin' | 'member' | 'guest' | null;
  genesisHash?: string;
  history: VerifiedLedgerHistory | null;
  loading: boolean;
  failure: E2eeControlFailure | null;
  unavailable?: boolean;
  /** The signed-in account; shown on the genesis member only when this device holds the creation pin. */
  you?: E2eeMemberProfile;
  /** Server-provided display profiles by crypto user ID. Display only: verify with the ledger code. */
  memberProfiles?: ReadonlyMap<string, E2eeMemberProfile>;
  /** Builds the support report on demand; it contains no keys or record bodies. */
  diagnostics: () => string;
  /** Deletes only unreadable optional caches, then refreshes. */
  onRepairLocal: () => void;
  /** User-confirmed: forget this device's observed history position, then refresh. */
  onResetProgress: () => void;
  onLoadMore: () => void;
  onRefresh: () => void;
  /** Leaves the console: back to a workspace on the page, closes the dialog. */
  onBack: () => void;
  /** Present only after the owning host accepted this device's read-open. */
  onOpen?: () => void;
  /** Present where the host can check for app updates (desktop). */
  onCheckForUpdates?: () => void;
  /** Whether this workspace can be restored from the account recovery file or passkey.
   * Undefined when recovery is unavailable on this host or its state is unknown. */
  recoveryReady?: boolean;
  /** Host-owned content; wrap it in `E2eeConsoleSection` to place it on a tab. */
  children?: ReactNode;
}

/** Encryption console: one frame for the standalone page and the Settings dialog. It
 * never mounts a workspace document or execution runtime. */
export function E2eeWorkspaceControlPage(props: E2eeWorkspaceControlPageProps) {
  const { t } = useTranslation();
  const { history } = props;
  const overview = useMemo(() => (history ? ledgerOverview(history) : null), [history]);
  const names = useMemberNames(history, overview, props.memberProfiles, props.you);
  const [helpOpen, setHelpOpen] = useState(false);
  const [tab, setTab] = useState<E2eeConsoleTab>(props.initialTab ?? 'overview');
  const sections = sectionsByTab(props.children);
  const total = history?.page.checkpoint.length ?? 0;
  const presentation = props.presentation ?? 'page';
  const deviceCount =
    overview?.members.reduce((count, member) => count + member.devices.length, 0) ?? 0;
  const mayManage =
    props.memberManagement !== undefined ||
    props.memberRole === 'owner' ||
    props.memberRole === 'admin';
  const tabLabel = (id: E2eeConsoleTab) => t(`e2ee.console.tabs.${id}`);

  const statusNotices = (
    <>
      {helpOpen && (
        <div {...stylex.props(styles.help)}>
          <p>{t('e2ee.verify.hint')}</p>
          <p>{t('e2ee.verify.hintCaveat')}</p>
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
          onRefresh={props.onRefresh}
          onNavigate={setTab}
          {...(props.onCheckForUpdates ? { onCheckForUpdates: props.onCheckForUpdates } : {})}
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
      {history?.view.inspectState().epoch.rotationRequired && (
        <Alert.Root tone="warning">
          <Alert.Description>{t('e2ee.members.rotationHint')}</Alert.Description>
        </Alert.Root>
      )}
    </>
  );

  const historySection = history && overview && (
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
                      <dt {...stylex.props(styles.fieldName)}>{t('e2ee.control.operation')}</dt>
                      <dd {...stylex.props(styles.muted)}>{t(`e2ee.events.${event.type}`)}</dd>
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
                      <summary {...stylex.props(styles.rawToggle)}>{t('e2ee.control.raw')}</summary>
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
  );

  const recent =
    history && overview
      ? history.records
          .map((record, position) => ({ record, event: overview.events[position] }))
          .slice(-3)
          .reverse()
      : [];

  const quickActions: { tab: E2eeConsoleTab; label: string; icon: LucideIcon }[] = [
    ...(mayManage
      ? [{ tab: 'members' as const, label: t('e2ee.console.quick.invite'), icon: Users }]
      : []),
    { tab: 'devices', label: t('e2ee.console.quick.addDevice'), icon: MonitorSmartphone },
    { tab: 'security', label: t('e2ee.console.quick.compare'), icon: ShieldCheck },
    { tab: 'recovery', label: t('e2ee.console.quick.recovery'), icon: LifeBuoy },
  ];

  // Getting started follows creation, so it is shown only on the creating device, the one
  // place this account's membership is known from the ledger itself.
  const genesis = overview?.events[0];
  const creator =
    history?.locallyPinned === true && genesis?.type === 'genesis'
      ? overview?.members.find((member) => member.membershipId === genesis.actor.membershipId)
      : undefined;
  const checklist: { id: string; done: boolean; tab?: E2eeConsoleTab }[] =
    creator && overview
      ? [
          { id: 'create', done: true },
          { id: 'invite', done: overview.members.length > 1, tab: 'members' },
          {
            id: 'device',
            done: creator.devices.filter((device) => device.kind === 'personal').length > 1,
            tab: 'devices',
          },
          ...(props.recoveryReady === undefined
            ? []
            : [{ id: 'recovery', done: props.recoveryReady, tab: 'recovery' as const }]),
        ]
      : [];
  const checklistDone = checklist.filter((item) => item.done).length;
  const gettingStarted = checklist.length > 0 && checklistDone < checklist.length && (
    <section
      data-testid="e2ee-getting-started"
      aria-label={t('e2ee.console.start.title')}
      {...stylex.props(styles.section)}
    >
      <h2 {...stylex.props(styles.sectionHeading)}>
        {t('e2ee.console.start.title')}
        <span {...stylex.props(styles.count)}>
          {checklistDone} / {checklist.length}
        </span>
      </h2>
      <ul {...stylex.props(styles.list)}>
        {checklist.map((item) => (
          <li
            key={item.id}
            data-start-item={item.id}
            data-done={item.done}
            {...stylex.props(styles.memberRow)}
          >
            <span
              aria-hidden="true"
              {...stylex.props(styles.checkMark, item.done && styles.checkMarkDone)}
            >
              {item.done ? <Check size={12} strokeWidth={3} /> : null}
            </span>
            <span {...stylex.props(styles.eventText, item.done && styles.checkDoneText)}>
              {t(`e2ee.console.start.${item.id}`)}
            </span>
            {!item.done && item.tab && (
              <Button size="small" variant="secondary" onClick={() => setTab(item.tab!)}>
                {t(`e2ee.console.start.${item.id}Action`)}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );

  const panels: Record<E2eeConsoleTab, ReactNode> = {
    overview: (
      <>
        {history && overview && (
          <div {...stylex.props(styles.hero)}>
            <span aria-hidden="true" {...stylex.props(styles.heroGlyph)}>
              <ShieldCheck size={18} />
            </span>
            <div {...stylex.props(styles.heroText)}>
              <span {...stylex.props(styles.heroTitle)}>{t('e2ee.console.status')}</span>
              <span {...stylex.props(styles.heroHelp)}>
                {t('e2ee.console.statusCounts', {
                  members: overview.members.length,
                  devices: deviceCount,
                })}
              </span>
            </div>
          </div>
        )}
        {sections.get('overview')}
        {gettingStarted}
        {history && overview && (
          <section aria-label={t('e2ee.console.quick.title')} {...stylex.props(styles.section)}>
            <h2 {...stylex.props(styles.sectionHeading)}>{t('e2ee.console.quick.title')}</h2>
            <div {...stylex.props(styles.quick)}>
              {quickActions.map((action) => (
                <button
                  key={action.tab + action.label}
                  type="button"
                  onClick={() => setTab(action.tab)}
                  {...stylex.props(styles.quickItem)}
                >
                  <action.icon size={18} aria-hidden="true" {...stylex.props(styles.quickIcon)} />
                  {action.label}
                </button>
              ))}
            </div>
          </section>
        )}
        {recent.length > 0 && (
          <section aria-label={t('e2ee.console.recent')} {...stylex.props(styles.section)}>
            <h2 {...stylex.props(styles.sectionHeading)}>
              {t('e2ee.console.recent')}
              <button
                type="button"
                onClick={() => setTab('security')}
                {...stylex.props(styles.linkButton)}
              >
                {t('e2ee.console.viewAll', { count: total })}
              </button>
            </h2>
            <ul {...stylex.props(styles.list)}>
              {recent.map(({ record, event }) => (
                <li key={record.hash} {...stylex.props(styles.memberRow)}>
                  <span {...stylex.props(styles.eventIndex)}>{record.index + 1}</span>
                  <span {...stylex.props(styles.eventText)}>
                    {eventSentence(t, names.name, event)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </>
    ),
    members: (
      <>
        {history && !mayManage && (
          <Alert.Root tone="neutral">
            <Alert.Description>{t('e2ee.console.adminRequired')}</Alert.Description>
          </Alert.Root>
        )}
        {history && overview && (
          <MembersSection overview={overview} names={names} management={props.memberManagement} />
        )}
        {sections.get('members')}
      </>
    ),
    devices: (
      <>
        {sections.get('devices')}
        {overview && !sections.has('devices') && (
          <p {...stylex.props(styles.quiet)}>{t('e2ee.console.devicesElsewhere')}</p>
        )}
      </>
    ),
    security: (
      <>
        {history && <LedgerVerificationCard history={history} />}
        {historySection}
        {sections.get('security')}
      </>
    ),
    recovery: sections.get('recovery') ?? (
      <p {...stylex.props(styles.quiet)}>{t('e2ee.console.recoveryElsewhere')}</p>
    ),
  };

  const frame = (
    <div
      data-testid="e2ee-workspace-console"
      {...stylex.props(styles.consoleFrame, presentation === 'page' && styles.consoleFramePage)}
    >
      <nav aria-label={t('e2ee.console.navigation')} {...stylex.props(styles.nav)}>
        <div {...stylex.props(styles.navIdentity)}>
          <span {...stylex.props(styles.navName)}>
            {props.workspaceName ?? t('e2ee.control.title')}
          </span>
          <Lock size={13} aria-label={t('e2ee.mark.list')} {...stylex.props(styles.navLock)} />
        </div>
        {E2EE_CONSOLE_TABS.map((id) => {
          const Icon = TAB_ICONS[id];
          return (
            <button
              key={id}
              type="button"
              aria-current={tab === id ? 'page' : undefined}
              data-console-tab={id}
              onClick={() => setTab(id)}
              {...stylex.props(styles.navItem, tab === id && styles.navItemActive)}
            >
              <Icon size={16} aria-hidden="true" />
              {tabLabel(id)}
            </button>
          );
        })}
      </nav>
      <main {...stylex.props(styles.main)}>
        <header {...stylex.props(styles.mainHeader)}>
          {presentation === 'page' && (
            <Button
              variant="ghost"
              size="small"
              icon
              aria-label={t('e2ee.control.back')}
              onClick={props.onBack}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </Button>
          )}
          <h1 data-testid="e2ee-workspace-control" {...stylex.props(styles.mainTitle)}>
            {tabLabel(tab)}
          </h1>
          {props.onOpen && (
            <Button
              variant="primary"
              disabled={props.loading || Boolean(props.failure)}
              onClick={props.onOpen}
            >
              {t('e2ee.control.openWorkspace')}
            </Button>
          )}
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
          {presentation === 'modal' && (
            <Button variant="ghost" icon aria-label={t('common.close')} onClick={props.onBack}>
              <X size={16} aria-hidden="true" />
            </Button>
          )}
        </header>
        <div {...stylex.props(styles.mainBody)}>
          {statusNotices}
          {panels[tab]}
        </div>
      </main>
    </div>
  );
  return presentation === 'page' ? <div {...stylex.props(styles.consolePage)}>{frame}</div> : frame;
}

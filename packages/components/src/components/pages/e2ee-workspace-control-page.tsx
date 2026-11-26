import { managementFailureKind } from '@/lib/e2ee-actionable-failure';
import { E2eeDiagnosticCode } from '@/components/e2ee-diagnostic-code';
import { E2eeMemberActions, type E2eeMemberManagement } from './e2ee-member-actions';
import * as stylex from '@stylexjs/stylex';
import { Accordion } from '@lody/ui/accordion';
import { Alert } from '@lody/ui/alert';
import { Avatar } from '@lody/ui/avatar';
import { CachedAvatarImage } from '@/components/cached-avatar-img';
import { Button } from '@lody/ui/button';
import { Collapsible } from '@lody/ui/collapsible';
import { Spinner } from '@lody/ui/spinner';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import {
  control,
  duration,
  ease,
  radius,
  space,
  text as type,
} from '@lody/ui/tokens/scales.stylex';
import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
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
import { copyTextToClipboard } from '@/lib/clipboard';
import { withClassName } from '@/lib/stylex';
import { settingsSurface as surface } from '../settings/surface';

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
  count: {
    color: colors.tertiaryLabel,
    fontWeight: 400,
    fontVariantNumeric: 'tabular-nums',
  },
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
    minHeight: 46,
    paddingBlock: space[1.5],
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
    minWidth: '6.5em',
    flexShrink: 0,
    textAlign: 'end',
    color: colors.secondaryLabel,
    fontSize: type.subheadlineSize,
    whiteSpace: 'nowrap',
  },
  memberDevices: {
    minWidth: '5em',
    flexShrink: 0,
    textAlign: 'end',
    color: colors.tertiaryLabel,
    fontSize: type.footnoteSize,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  memberActionSlot: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: control.small,
    height: control.small,
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
  loadingRow: { display: 'flex', alignItems: 'center', gap: space[2] },
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
    gridTemplateColumns: '220px minmax(0, 1fr)',
    gridTemplateRows: 'minmax(0, 1fr)',
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
    flexDirection: 'column',
    gap: '2px',
    paddingBlock: space[4],
    paddingInline: space[3],
    backgroundColor: colors.secondaryBackground,
  },
  navIdentity: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    paddingInline: space[3],
    paddingBottom: space[4],
    minWidth: 0,
  },
  navName: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  navLock: { flexShrink: 0, color: colors.secondaryLabel },
  navItem: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    flexShrink: 0,
    minHeight: '34px',
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
    transitionProperty: 'background-color, color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  navItemActive: { backgroundColor: colors.wellBackground, fontWeight: 600 },
  navIcon: { flexShrink: 0, color: colors.secondaryLabel },
  navIconActive: { color: colors.label },
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
    paddingInline: space[6],
  },
  mainTitleGroup: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    minWidth: 0,
  },
  mainTitle: {
    margin: 0,
    fontSize: type.titleSize,
    lineHeight: type.titleLeading,
    fontWeight: 600,
    minWidth: 0,
  },
  mainBody: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingInline: space[6],
    paddingBottom: space[6],
    display: 'flex',
    flexDirection: 'column',
    gap: space[6],
  },
  mobileFrame: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    minHeight: 0,
    overflow: 'hidden',
    backgroundColor: colors.background,
    color: colors.label,
    fontSize: type.bodySize,
    lineHeight: 1.45,
  },
  mobileHeader: {
    position: 'sticky',
    top: 0,
    zIndex: 30,
    display: 'grid',
    gridTemplateColumns: '4.5rem minmax(0, 1fr) 4.5rem',
    alignItems: 'center',
    gap: space[2],
    paddingTop: space[2],
    paddingBottom: space[2],
    paddingInline: space[3],
  },
  mobileHeaderModal: {
    gridTemplateColumns: '6.5rem minmax(0, 1fr) 6.5rem',
  },
  mobileBackButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    justifySelf: 'start',
    width: '36px',
    height: '36px',
    flexShrink: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: '9999px',
    backgroundColor: colors.elevatedBackground,
    color: colors.label,
    boxShadow: shadow.card,
    cursor: 'pointer',
    transitionProperty: 'transform',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
    transform: { default: 'scale(1)', ':active': 'scale(0.97)' },
  },
  mobileHeaderTitle: {
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'center',
    fontSize: '0.98rem',
    fontWeight: 500,
    letterSpacing: '-0.02em',
    color: colors.label,
  },
  mobileHeaderActions: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    justifySelf: 'end',
    gap: space[1],
  },
  mobileBody: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingInline: space[4],
    paddingTop: space[3],
    paddingBottom: space[6],
    display: 'flex',
    flexDirection: 'column',
    gap: space[4],
  },
  mobileMenuRow: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    width: '100%',
    minHeight: '48px',
    margin: 0,
    paddingInline: space[4],
    paddingBlock: space[3],
    borderWidth: 0,
    backgroundColor: {
      default: 'transparent',
      ':hover': `color-mix(in oklab, ${colors.elevatedBackground}, ${colors.label} 4%)`,
      ':active': `color-mix(in oklab, ${colors.elevatedBackground}, ${colors.label} 6%)`,
    },
    color: colors.label,
    fontFamily: 'inherit',
    fontSize: type.bodySize,
    textAlign: 'start',
    cursor: 'pointer',
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  mobileMenuIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '24px',
    height: '24px',
    color: colors.secondaryLabel,
  },
  mobileMenuLabel: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 400,
    color: colors.label,
  },
  mobileMenuChevron: {
    flexShrink: 0,
    color: colors.tertiaryLabel,
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
  checkText: {
    flexGrow: 1,
    minWidth: 0,
    whiteSpace: 'normal',
    textAlign: 'start',
    fontWeight: 400,
  },
  checkDoneText: { color: colors.secondaryLabel },
});

const TAB_ICONS: Record<E2eeConsoleTab, LucideIcon> = {
  overview: LayoutDashboard,
  members: Users,
  devices: MonitorSmartphone,
  security: ShieldCheck,
  recovery: LifeBuoy,
};

function useIsNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 720px)').matches
      : false
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(max-width: 720px)');
    const update = () => setNarrow(mql.matches);
    update();
    mql.addEventListener?.('change', update);
    return () => mql.removeEventListener?.('change', update);
  }, []);
  return narrow;
}

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
      await copyTextToClipboard(text);
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
      <Alert.Description>{t(card.body)}</Alert.Description>
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
      {props.failure.kind === 'server' && <E2eeDiagnosticCode code={props.failure.code} />}
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
    case 'abandonEpoch':
      return t('e2ee.summary.abandonEpoch', {
        actor,
        epoch: event.epoch,
        baseEpoch: event.baseEpoch,
      });
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
  onRotationSettled: (replaced: boolean) => void;
}) {
  const { t } = useTranslation();
  const { names } = props;
  const [actionError, setActionError] = useState<string>();
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
      {actionError && (
        <Alert.Root tone="warning" data-testid="e2ee-member-action-error">
          <Alert.Description>{t(actionError)}</Alert.Description>
        </Alert.Root>
      )}
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
                <CachedAvatarImage src={profile?.image} alt="" />
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
                <span {...stylex.props(styles.memberActionSlot)}>
                  <E2eeMemberActions
                    member={member}
                    name={name}
                    management={props.management}
                    onRotationSettled={props.onRotationSettled}
                    onError={setActionError}
                  />
                </span>
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
  initialMobileView?: 'menu' | 'detail';
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
  /** Disables the Open workspace button while route metadata is still settling. */
  openDisabled?: boolean;
  /** Additional status notices rendered inside the main scroll body. */
  notices?: ReactNode;
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
  const isNarrow = useIsNarrowViewport();
  const [mobileView, setMobileView] = useState<'menu' | 'detail'>(
    () => props.initialMobileView ?? (props.initialTab ? 'detail' : 'menu')
  );
  const selectTab = (next: E2eeConsoleTab) => {
    setTab(next);
    if (isNarrow) setMobileView('detail');
  };
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
  // A key update that failed after a removal. It lives here, not in the member's row:
  // the removal reloads the list, which unmounts every row's actions and drops the
  // removed member's row for good.
  const [keyUpdate, setKeyUpdate] = useState<{
    readonly workspaceId: string;
    readonly message: string;
    readonly retrying?: boolean;
  } | null>(null);
  const keyUpdateState = keyUpdate?.workspaceId === props.workspaceId ? keyUpdate : null;
  const settleRotation = (replaced: boolean) =>
    setKeyUpdate(
      replaced ? null : { workspaceId: props.workspaceId, message: 'e2ee.members.rotateFailed' }
    );
  const rotate = props.memberManagement?.rotate;
  const retryKeyUpdate = async (update: () => Promise<void>) => {
    const workspaceId = props.workspaceId;
    const settle = (next: typeof keyUpdate) =>
      setKeyUpdate((current) => (current?.workspaceId === workspaceId ? next : current));
    settle({ workspaceId, message: 'e2ee.members.rotateRetrying', retrying: true });
    try {
      await update();
      settle(null);
    } catch (error) {
      const kind = managementFailureKind(error);
      settle({
        workspaceId,
        message:
          kind === 'generic'
            ? 'e2ee.members.rotateRetryFailed'
            : `e2ee.members.rotateError.${kind}`,
      });
    }
  };

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
          onNavigate={selectTab}
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
      {props.notices}
      {props.loading && !history && (
        <p role="status" {...stylex.props(styles.quiet, styles.loadingRow)}>
          <Spinner size="small" />
          {t('e2ee.control.loading')}
        </p>
      )}
      {keyUpdateState && (
        <Alert.Root tone="warning" data-testid="e2ee-member-rotate-failed">
          <Alert.Description role="status">{t(keyUpdateState.message)}</Alert.Description>
          <Alert.Actions>
            <Button
              data-testid="e2ee-member-rotate-retry"
              disabled={!rotate || keyUpdateState.retrying}
              onClick={() => {
                if (rotate) void retryKeyUpdate(rotate);
              }}
            >
              {t('e2ee.members.rotateRetry')}
            </Button>
          </Alert.Actions>
        </Alert.Root>
      )}
      {!keyUpdateState && history?.view.inspectState().epoch.rotationRequired && (
        <Alert.Root tone="warning">
          <Alert.Description>{t('e2ee.members.rotationHint')}</Alert.Description>
          {rotate && (
            <Alert.Actions>
              <Button
                variant="primary"
                size="small"
                data-testid="e2ee-rotation-required-rotate"
                onClick={() => void retryKeyUpdate(rotate)}
              >
                {t('e2ee.security.complete')}
              </Button>
            </Alert.Actions>
          )}
        </Alert.Root>
      )}
    </>
  );

  // The full record, with hashes and fields, is for auditing: closed until asked for.
  // It stays mounted so its loaded pages and open rows survive closing it.
  const historySection = history && overview && (
    <section aria-label={t('e2ee.control.history')} {...stylex.props(styles.section)}>
      <Collapsible.Root>
        <Collapsible.Trigger
          render={<Button variant="ghost" size="small" data-testid="e2ee-history-toggle" />}
        >
          {t('e2ee.control.historyToggle', {
            shown: history.view.length < total ? `${history.view.length} / ${total}` : total,
          })}
          <ChevronDown size={14} aria-hidden="true" />
        </Collapsible.Trigger>
        <Collapsible.Panel keepMounted>
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
        </Collapsible.Panel>
      </Collapsible.Root>
    </section>
  );

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
            <span {...stylex.props(styles.checkText, item.done && styles.checkDoneText)}>
              {t(`e2ee.console.start.${item.id}`)}
            </span>
            {!item.done && item.tab && (
              <Button
                size="small"
                variant={item.id === 'recovery' ? 'primary' : 'secondary'}
                onClick={() => selectTab(item.tab!)}
              >
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
                  members: t('e2ee.control.memberCount', { count: overview.members.length }),
                  devices: t('e2ee.control.deviceCount', { count: deviceCount }),
                })}
              </span>
            </div>
          </div>
        )}
        {sections.get('overview')}
        {gettingStarted}
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
          <MembersSection
            overview={overview}
            names={names}
            management={props.memberManagement}
            onRotationSettled={settleRotation}
          />
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
      <p {...stylex.props(styles.quiet)}>{t('e2ee.console.recoveryUnavailable')}</p>
    ),
  };

  const headerActionButtons = (
    <>
      <Button
        variant="ghost"
        size={isNarrow ? 'small' : undefined}
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
        size={isNarrow ? 'small' : undefined}
        icon
        aria-label={t('e2ee.control.help')}
        aria-expanded={helpOpen}
        title={t('e2ee.control.help')}
        onClick={() => setHelpOpen((open) => !open)}
      >
        <CircleHelp size={16} aria-hidden="true" />
      </Button>
      {presentation === 'modal' && (
        <Button
          variant="ghost"
          size={isNarrow ? 'small' : undefined}
          icon
          aria-label={t('common.close')}
          onClick={props.onBack}
        >
          <X size={16} aria-hidden="true" />
        </Button>
      )}
    </>
  );

  const frame = isNarrow ? (
    <div data-testid="e2ee-workspace-console" {...stylex.props(styles.mobileFrame)}>
      <header
        {...withClassName(
          stylex.props(styles.mobileHeader, presentation === 'modal' && styles.mobileHeaderModal),
          'mobile-home-glass'
        )}
      >
        <button
          type="button"
          onClick={mobileView === 'detail' ? () => setMobileView('menu') : props.onBack}
          aria-label={mobileView === 'detail' ? t('common.back') : t('e2ee.control.back')}
          {...stylex.props(styles.mobileBackButton)}
        >
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <h1 data-testid="e2ee-workspace-control" {...stylex.props(styles.mobileHeaderTitle)}>
          {mobileView === 'detail'
            ? tabLabel(tab)
            : (props.workspaceName ?? t('e2ee.control.title'))}
        </h1>
        <div {...stylex.props(styles.mobileHeaderActions)}>{headerActionButtons}</div>
      </header>
      <main {...stylex.props(styles.mobileBody)}>
        {statusNotices}
        {mobileView === 'menu' ? (
          <>
            {props.onOpen && (
              <Button
                variant="primary"
                disabled={props.loading || Boolean(props.failure) || props.openDisabled}
                onClick={props.onOpen}
              >
                {t('e2ee.control.openWorkspace')}
              </Button>
            )}
            <nav
              aria-label={t('e2ee.console.navigation')}
              data-testid="e2ee-mobile-menu"
              {...stylex.props(surface.card)}
            >
              {E2EE_CONSOLE_TABS.map((id, index) => {
                const Icon = TAB_ICONS[id];
                return (
                  <button
                    key={id}
                    type="button"
                    data-console-tab={id}
                    onClick={() => selectTab(id)}
                    {...stylex.props(styles.mobileMenuRow, index > 0 && surface.lineRuled)}
                  >
                    <span {...stylex.props(styles.mobileMenuIcon)} aria-hidden="true">
                      <Icon size={18} />
                    </span>
                    <span {...stylex.props(styles.mobileMenuLabel)}>{tabLabel(id)}</span>
                    {id === 'recovery' && props.recoveryReady === false && (
                      <span
                        data-testid="e2ee-mobile-recovery-unset"
                        {...stylex.props(styles.quiet)}
                      >
                        {t('e2ee.control.recoveryNotSet')}
                      </span>
                    )}
                    <ChevronRight
                      size={16}
                      aria-hidden="true"
                      {...stylex.props(styles.mobileMenuChevron)}
                    />
                  </button>
                );
              })}
            </nav>
          </>
        ) : (
          panels[tab]
        )}
      </main>
    </div>
  ) : (
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
              onClick={() => selectTab(id)}
              {...stylex.props(styles.navItem, tab === id && styles.navItemActive)}
            >
              <Icon
                size={16}
                aria-hidden="true"
                {...stylex.props(styles.navIcon, tab === id && styles.navIconActive)}
              />
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
          <div {...stylex.props(styles.mainTitleGroup)}>
            <h1 data-testid="e2ee-workspace-control" {...stylex.props(styles.mainTitle)}>
              {tabLabel(tab)}
            </h1>
          </div>
          {props.onOpen && (
            <Button
              variant="primary"
              disabled={props.loading || Boolean(props.failure) || props.openDisabled}
              onClick={props.onOpen}
            >
              {t('e2ee.control.openWorkspace')}
            </Button>
          )}
          {headerActionButtons}
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

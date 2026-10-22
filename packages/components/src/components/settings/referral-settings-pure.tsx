import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Check, ChevronRight, Copy, Share } from 'lucide-react';
import type { ReferralLedgerEntry, ReferralOverview } from '@lody/cloud-api';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Skeleton } from '@lody/ui/skeleton';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { Dialog } from '@/ui/dialog';
import { CompactSection } from './compact-layout';
import { formatUsd } from './billing-setting-pure';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';
import { settingsType as type } from './type.stylex';

/**
 * Referrals on the billing page are one card under the plan: the link to share and
 * the credit it has earned. Everything else — the breakdown, the history and the
 * rules — waits behind a quiet "Details" link, in a dialog. Money is integer USD
 * cents; the copy never names ledger mechanics (reservations, wallets, claims).
 */
const styles = stylex.create({
  block: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
    paddingInline: space[4],
    paddingBlock: space[3],
    minWidth: 0,
  },
  head: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space[4],
  },
  text: { minWidth: 0 },
  credit: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0 },
  creditValue: {
    fontSize: '1.25em',
    lineHeight: type.leading,
    color: colors.label,
    fontVariantNumeric: 'tabular-nums',
  },
  creditMeta: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
    fontSize: text.footnoteSize,
    lineHeight: type.leading,
    color: colors.secondaryLabel,
  },
  detailsLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '2px',
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    fontFamily: 'inherit',
    fontSize: text.footnoteSize,
    lineHeight: type.leading,
    cursor: 'pointer',
  },
  detailsMark: { width: '12px', height: '12px', flexShrink: 0 },
  linkRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[2], minWidth: 0 },
  linkField: { flexGrow: 1, flexBasis: '240px', minWidth: 0 },
  linkActions: { display: 'flex', flexShrink: 0, gap: space[2] },
  note: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: type.leading,
    color: colors.secondaryLabel,
  },

  dialogBody: { display: 'flex', flexDirection: 'column', gap: space[4], minWidth: 0 },
  group: { display: 'flex', flexDirection: 'column', gap: space[2], minWidth: 0 },
  groupTitle: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: type.leading,
    color: colors.secondaryLabel,
  },
  figures: { display: 'flex', flexDirection: 'column', gap: space[2], margin: 0 },
  figure: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space[4],
  },
  figureLabel: {
    margin: 0,
    fontSize: text.bodySize,
    lineHeight: type.leading,
    color: colors.label,
  },
  figureHelp: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: type.leading,
    color: colors.secondaryLabel,
  },
  amount: {
    flexShrink: 0,
    margin: 0,
    fontSize: text.bodySize,
    color: colors.label,
    fontVariantNumeric: 'tabular-nums',
  },
  amountMuted: { color: colors.secondaryLabel },
  perks: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1.5],
    margin: 0,
    padding: 0,
    listStyleType: 'none',
    fontSize: text.footnoteSize,
    lineHeight: type.leading,
    color: colors.label,
  },
  perk: { display: 'flex', alignItems: 'flex-start', gap: space[1.5], minWidth: 0 },
  perkMark: {
    width: '14px',
    height: '14px',
    marginTop: '2px',
    flexShrink: 0,
    color: colors.accent,
  },
  entries: {
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '280px',
    overflowY: 'auto',
    margin: 0,
    padding: 0,
    listStyleType: 'none',
  },
  entry: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[4],
    paddingBlock: space[2],
  },
  pager: { display: 'flex', justifyContent: 'flex-end', gap: space[2] },
});

type EntryTone = 'gain' | 'loss' | 'hold';

/** The ledger stores signed deltas; a person reads a named event and a signed amount. */
export function describeReferralEntry(entry: ReferralLedgerEntry): {
  key: string;
  amount: number;
  tone: EntryTone;
} {
  switch (entry.kind) {
    case 'reward':
      return { key: 'referral.entry.reward', amount: entry.amount, tone: 'gain' };
    case 'adjustment':
      return { key: 'referral.entry.reversal', amount: entry.amount, tone: 'loss' };
    case 'use':
      return { key: 'referral.entry.use', amount: entry.amount, tone: 'loss' };
    case 'release':
      return { key: 'referral.entry.release', amount: entry.amount, tone: 'gain' };
    case 'freeze':
      return entry.frozen >= 0
        ? { key: 'referral.entry.hold', amount: entry.frozen, tone: 'hold' }
        : { key: 'referral.entry.unhold', amount: -entry.frozen, tone: 'hold' };
  }
  return assertNever(entry.kind);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled referral ledger kind: ${String(value)}`);
}

function signedUsd(amount: number, tone: EntryTone) {
  if (tone === 'hold') return formatUsd(Math.abs(amount));
  return `${amount < 0 ? '−' : '+'}${formatUsd(Math.abs(amount))}`;
}

export interface ReferralSettingsViewProps {
  /** `undefined` while loading. */
  overview: ReferralOverview | undefined;
  /** Admins and owners create the link; every member can copy an existing one. */
  canManage: boolean;
  linkPending?: boolean;
  /** The link was just copied: the button says so for a moment. */
  copied?: boolean;
  onCopy: () => void;
  /** Present where the platform has a native share sheet. */
  onShare?: () => void;
  onOpenDetails: () => void;
}

/** The referral card under the plan: the link and the credit, with details one click away. */
export function ReferralSettingsView({
  overview,
  canManage,
  linkPending = false,
  copied = false,
  onCopy,
  onShare,
  onOpenDetails,
}: ReferralSettingsViewProps) {
  const { t } = useTranslation();
  if (!overview) {
    return (
      <CompactSection>
        <div {...stylex.props(styles.block)} aria-busy="true">
          <Skeleton width="40%" height="16px" />
          <Skeleton width="100%" height="28px" />
        </div>
      </CompactSection>
    );
  }
  const hasActivity =
    overview.code !== null || overview.issued > 0 || overview.spent > 0 || overview.adjustment > 0;
  // Plans that cannot refer (Enterprise, Founder, gifts) and never have show nothing.
  if (!overview.eligible && !hasActivity) return null;

  const url = overview.url;
  let action;
  if (!overview.eligible) {
    action = <p {...stylex.props(styles.note)}>{t('referral.ineligible')}</p>;
  } else if (url) {
    action = (
      <div {...stylex.props(styles.linkRow)}>
        <div {...stylex.props(styles.linkField)}>
          <Input
            size="small"
            readOnly
            value={url}
            aria-label={t('referral.link')}
            onFocus={(event) => event.currentTarget.select()}
            spellCheck={false}
          />
        </div>
        <div {...stylex.props(styles.linkActions)}>
          <Button size="small" variant="secondary" onClick={onCopy} aria-live="polite">
            {copied ? (
              <Check aria-hidden="true" {...stylex.props(catalog.icon)} />
            ) : (
              <Copy aria-hidden="true" {...stylex.props(catalog.icon)} />
            )}
            {copied ? t('referral.copied') : t('referral.copy')}
          </Button>
          {onShare ? (
            <Button size="small" variant="secondary" onClick={onShare}>
              <Share aria-hidden="true" {...stylex.props(catalog.icon)} />
              {t('referral.share')}
            </Button>
          ) : null}
        </div>
      </div>
    );
  } else if (canManage) {
    action = (
      <div {...stylex.props(styles.linkRow)}>
        <Button size="small" variant="secondary" disabled={linkPending} onClick={onCopy}>
          {linkPending ? <Spinner size="small" /> : null}
          {t('referral.generate')}
        </Button>
      </div>
    );
  } else {
    action = <p {...stylex.props(styles.note)}>{t('referral.memberHint')}</p>;
  }

  return (
    <CompactSection>
      <div {...stylex.props(styles.block)}>
        <div {...stylex.props(styles.head)}>
          <div {...stylex.props(styles.text)}>
            <p {...stylex.props(surface.rowLabel)}>{t('referral.title')}</p>
            <p {...stylex.props(surface.rowHelper)}>{t('referral.description')}</p>
          </div>
          <div {...stylex.props(styles.credit)}>
            <span {...stylex.props(styles.creditValue)}>{formatUsd(overview.available)}</span>
            <span {...stylex.props(styles.creditMeta)}>
              {t('referral.available')}
              <span aria-hidden="true">·</span>
              <button type="button" onClick={onOpenDetails} {...stylex.props(styles.detailsLink)}>
                {t('referral.details')}
                <ChevronRight aria-hidden="true" {...stylex.props(styles.detailsMark)} />
              </button>
            </span>
          </div>
        </div>
        {action}
      </div>
    </CompactSection>
  );
}

function Figure({
  label,
  help,
  value,
  muted = false,
}: {
  label: string;
  help?: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div {...stylex.props(styles.figure)}>
      <div {...stylex.props(styles.text)}>
        <dt {...stylex.props(styles.figureLabel)}>{label}</dt>
        {help ? <p {...stylex.props(styles.figureHelp)}>{help}</p> : null}
      </div>
      <dd {...stylex.props(styles.amount, muted && styles.amountMuted)}>{value}</dd>
    </div>
  );
}

export interface ReferralDetailsDialogProps {
  overview: ReferralOverview;
  /** `undefined` while the current history page loads. */
  entries: ReferralLedgerEntry[] | undefined;
  onNewer?: () => void;
  onOlder?: () => void;
  onClose: () => void;
}

/** The credit's breakdown, the history and the rules, opened from the card's "Details". */
export function ReferralDetailsDialog({
  overview,
  entries,
  onNewer,
  onOlder,
  onClose,
}: ReferralDetailsDialogProps) {
  const { t, i18n } = useTranslation();
  const locale = toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language);
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const perks = [t('referral.perkDiscount'), t('referral.perkReward'), t('referral.perkShared')];
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>{t('referral.detailsTitle')}</Dialog.Title>
          <Dialog.Description>{t('referral.availableHelp')}</Dialog.Description>
        </Dialog.Header>
        <div {...stylex.props(styles.dialogBody)}>
          <dl {...stylex.props(styles.figures)}>
            <Figure label={t('referral.available')} value={formatUsd(overview.available)} />
            <Figure label={t('referral.earned')} value={formatUsd(overview.issued)} muted />
            <Figure
              label={t('referral.used')}
              value={overview.spent > 0 ? `−${formatUsd(overview.spent)}` : formatUsd(0)}
              muted
            />
            {overview.frozen > 0 ? (
              <Figure
                label={t('referral.frozen')}
                help={t('referral.frozenHelp')}
                value={formatUsd(overview.frozen)}
                muted
              />
            ) : null}
            {overview.adjustment > 0 ? (
              <Figure
                label={t('referral.adjustment')}
                help={t('referral.adjustmentHelp')}
                value={formatUsd(overview.adjustment)}
                muted
              />
            ) : null}
          </dl>

          <section {...stylex.props(styles.group)}>
            <p {...stylex.props(styles.groupTitle)}>{t('referral.history')}</p>
            {entries === undefined ? (
              <div {...stylex.props(styles.figures)} aria-busy="true">
                <Skeleton width="100%" height="16px" />
                <Skeleton width="100%" height="16px" />
              </div>
            ) : entries.length === 0 ? (
              <p {...stylex.props(styles.note)}>{t('referral.historyEmpty')}</p>
            ) : (
              <ul {...stylex.props(styles.entries)}>
                {entries.map((entry, index) => {
                  const { key, amount, tone } = describeReferralEntry(entry);
                  return (
                    <li
                      key={entry.id}
                      {...stylex.props(styles.entry, index > 0 && surface.lineRuled)}
                    >
                      <div {...stylex.props(styles.text)}>
                        <p {...stylex.props(styles.figureLabel)}>{t(key)}</p>
                        <p {...stylex.props(styles.figureHelp)}>
                          {dateFormat.format(new Date(entry.createdAt))}
                        </p>
                      </div>
                      <span {...stylex.props(styles.amount, tone === 'hold' && styles.amountMuted)}>
                        {signedUsd(amount, tone)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {onNewer || onOlder ? (
              <div {...stylex.props(styles.pager)}>
                <Button size="small" variant="ghost" disabled={!onNewer} onClick={onNewer}>
                  {t('referral.newer')}
                </Button>
                <Button size="small" variant="ghost" disabled={!onOlder} onClick={onOlder}>
                  {t('referral.older')}
                </Button>
              </div>
            ) : null}
          </section>

          <section {...stylex.props(styles.group)}>
            <p {...stylex.props(styles.groupTitle)}>{t('referral.rulesTitle')}</p>
            <ul {...stylex.props(styles.perks)}>
              {perks.map((perk) => (
                <li key={perk} {...stylex.props(styles.perk)}>
                  <Check aria-hidden="true" {...stylex.props(styles.perkMark)} />
                  <span>{perk}</span>
                </li>
              ))}
            </ul>
            <p {...stylex.props(styles.note)}>{t('referral.terms')}</p>
          </section>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/**
 * The newcomer discount, where a first subscription is bought: shown only when
 * the server confirmed that checkout would apply it.
 */
export function ReferralOfferNotice({
  interval,
  regularCents,
  onRemove,
  disabled = false,
}: {
  interval: 'month' | 'year';
  /** Regular per-seat price for one billing period. */
  regularCents: number;
  /** Absent when the discount is already bound to this workspace. */
  onRemove?: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const values = {
    first: formatUsd(Math.round(regularCents * 0.9)),
    regular: formatUsd(regularCents),
  };
  return (
    <div {...stylex.props(surface.formBlock, styles.head)} role="status">
      <div {...stylex.props(styles.text)}>
        <p {...stylex.props(surface.rowLabel)}>
          {t('referral.offerTitle')} <Badge tone="success">{t('referral.offerBadge')}</Badge>
        </p>
        <p {...stylex.props(surface.rowHelper)}>
          {interval === 'year'
            ? t('referral.offerYearly', values)
            : t('referral.offerMonthly', values)}
        </p>
      </div>
      {onRemove ? (
        <Button size="small" variant="ghost" disabled={disabled} onClick={onRemove}>
          {t('referral.remove')}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Referral credit paying toward the first subscription. `creditCents` is what the
 * credit covers of `firstPaymentCents` (both pre-tax); Stripe shows the final total.
 */
export function ReferralCreditNotice({
  creditCents,
  firstPaymentCents,
}: {
  creditCents: number;
  firstPaymentCents: number;
}) {
  const { t } = useTranslation();
  const covered = creditCents >= firstPaymentCents;
  return (
    <div {...stylex.props(surface.formBlock, styles.head)} role="status">
      <div {...stylex.props(styles.text)}>
        <p {...stylex.props(surface.rowLabel)}>{t('referral.creditTitle')}</p>
        <p {...stylex.props(surface.rowHelper)}>
          {covered
            ? t('referral.creditCovered')
            : t('referral.creditPartial', {
                remaining: formatUsd(firstPaymentCents - creditCents),
              })}
        </p>
      </div>
      <span {...stylex.props(styles.creditValue)}>−{formatUsd(creditCents)}</span>
    </div>
  );
}

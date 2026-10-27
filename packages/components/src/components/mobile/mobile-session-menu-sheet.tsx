import { useEffect, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Copy, UserRoundCog } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';

import { UserAvatar } from '@/components/user-avatar';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { sheetSurface } from './sheet-surface';

/**
 * Bottom sheet that replaces the mobile session header "…" dropdown. A dropdown
 * with a nested Copy submenu overflowed narrow screens, so this presents the
 * same options as a flat sheet: a read-only info block (machine, base/current
 * branch, project path — tap to copy) on top, then the flat action list
 * (find / fork / rename / copy / archive / restore / delete).
 *
 * Pure component — the caller (`session-detail.tsx`) resolves the rows/actions.
 */
export type MobileSessionMenuInfoRow = {
  id: string;
  icon: ReactNode;
  label: string;
  value: string;
  /** Allow long values such as file paths to wrap instead of being truncated. */
  wrapValue?: boolean;
  /** Tap-to-copy; renders a copy affordance when provided. */
  onCopy?: () => void;
  /** Trailing node (e.g. an online dot for the machine row). */
  trailing?: ReactNode;
};

export type MobileSessionMenuAction = {
  id: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** Draw a divider above this action (groups copy vs archive, etc.). */
  separatorBefore?: boolean;
};

/**
 * Owner transfer. The sheet is deliberately flat, so this renders as a single
 * disclosure row (current owner + chevron) that expands the member list in
 * place — a workspace with many members must not push the actions off screen.
 * Only passed on multi-member workspaces.
 */
export type MobileSessionMenuOwner = {
  members: { userId: string; name: string; image?: string | null }[];
  /** Current `SessionMeta.userId`; may name someone who already left. */
  ownerUserId: string;
  onSelect: (userId: string) => void;
};

export type MobileSessionMenuSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  infoRows: MobileSessionMenuInfoRow[];
  actions: MobileSessionMenuAction[];
  owner?: MobileSessionMenuOwner;
};

/** Tailwind's `transition-colors`: colour properties only, 150ms, standard ease. */
const TRANSITION_COLORS = {
  transitionProperty: 'color, background-color, border-color, text-decoration-color, fill, stroke',
  transitionDuration: '150ms',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

const styles = stylex.create({
  /** The card of information rows. */
  infoCard: { marginBottom: themeSpace[2] },
  /** The card that holds the owner disclosure. */
  ownerCard: {
    marginBottom: themeSpace[2],
    overflow: 'hidden',
  },

  /** A row that copies its value when tapped. */
  infoRowCopyable: {
    backgroundColor: { default: null, ':hover': 'hsl(var(--muted) / 0.6)' },
    ...TRANSITION_COLORS,
  },
  /** A row that only reads. */
  infoRowPlain: { cursor: 'default' },

  /** The glyph column of a row. */
  rowGlyph: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: themeSpace[4],
    height: themeSpace[4],
    color: themeColors.mutedForeground,
  },
  /** The row's text column. */
  rowText: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    flexDirection: 'column',
    gap: themeSpace[0.5],
  },
  /** The row's name, above its value. */
  rowLabel: {
    fontSize: '0.68rem',
    fontWeight: themeFontWeight.medium,
    letterSpacing: '0.025em',
    color: 'hsl(var(--muted-foreground) / 0.7)',
  },
  /** The row's value, beside its trailing node. */
  rowValueLine: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: themeSpace[1.5],
  },
  /** The row's value. */
  rowValue: {
    minWidth: 0,
    fontSize: themeFontSize.sm,
    lineHeight: 1.25,
    color: themeColors.foreground,
  },
  /** A value that wraps instead of being truncated. */
  rowValueWrap: { wordBreak: 'break-all' },
  /** A value that is clipped to its column. */
  rowValueTruncate: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** The copy affordance at the end of a copyable row. */
  rowCopyGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    color: 'hsl(var(--muted-foreground) / 0.6)',
  },

  /** The owner disclosure row. */
  ownerRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    userSelect: 'none',
    gap: themeSpace[3],
    paddingInline: themeSpace[3.5],
    paddingTop: themeSpace[2.5],
    paddingBottom: themeSpace[2.5],
    textAlign: 'left',
    backgroundColor: { default: null, ':hover': 'hsl(var(--muted) / 0.6)' },
    ...TRANSITION_COLORS,
  },
  /** The list of members, under the disclosure row. */
  ownerList: {
    display: 'flex',
    maxHeight: '16rem',
    flexDirection: 'column',
    overflowY: 'auto',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border) / 0.4)',
  },
  /** One member of the list. */
  memberRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    userSelect: 'none',
    gap: themeSpace[2.5],
    paddingInline: themeSpace[3.5],
    paddingTop: themeSpace[2.5],
    paddingBottom: themeSpace[2.5],
    textAlign: 'left',
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    backgroundColor: { default: null, ':hover': 'hsl(var(--muted) / 0.6)' },
    ...TRANSITION_COLORS,
  },
  /** A member's name. */
  memberName: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: themeColors.foreground,
  },
  /** The check beside the owner. */
  ownerCheck: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    color: themeColors.mutedForeground,
  },
  /** The owner's glyph. */
  ownerGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
  },
  /** The chevron that opens the member list. */
  ownerChevron: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    color: 'hsl(var(--muted-foreground) / 0.6)',
    rotate: '0deg',
    transitionProperty: 'transform',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  ownerChevronOpen: { rotate: '180deg' },

  /** The stack of actions. */
  actions: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[0.5],
  },
  /** The rule that groups actions. */
  actionSeparator: {
    height: '1px',
    marginTop: themeSpace[1],
    marginBottom: themeSpace[1],
    backgroundColor: 'hsl(var(--border) / 0.6)',
  },
  /** One action. */
  action: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    userSelect: 'none',
    gap: themeSpace[2.5],
    paddingInline: themeSpace[3],
    paddingTop: themeSpace[2.5],
    paddingBottom: themeSpace[2.5],
    textAlign: 'left',
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    borderRadius: themeRadius.lg,
    cursor: { default: null, ':disabled': 'not-allowed' },
    opacity: { default: 1, ':disabled': 0.5 },
    ...TRANSITION_COLORS,
  },
  /** The glyph column of an action. */
  actionGlyph: {
    display: 'flex',
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** An action's label. */
  actionLabel: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** An ordinary action. */
  actionIdle: {
    color: themeColors.foreground,
    backgroundColor: { default: null, ':hover': 'hsl(var(--muted) / 0.6)' },
  },
  /** An action that destroys something. */
  actionDestructive: {
    color: themeColors.destructive,
    backgroundColor: { default: null, ':hover': 'hsl(var(--destructive) / 0.1)' },
  },
});

export function MobileSessionMenuSheet({
  open,
  onOpenChange,
  title,
  infoRows,
  actions,
  owner,
}: MobileSessionMenuSheetProps) {
  const { t } = useTranslation();
  const heading = title ?? t('sessions.moreActions', 'More actions');
  const [ownerListOpen, setOwnerListOpen] = useState(false);
  // Reopening the sheet should start from the collapsed row again.
  useEffect(() => {
    if (!open) setOwnerListOpen(false);
  }, [open]);
  const ownerName =
    owner?.members.find((member) => member.userId === owner.ownerUserId)?.name ?? null;

  const run = (fn: () => void) => {
    fn();
    onOpenChange(false);
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      <DrawerContent className="h-auto! max-h-[85dvh]! rounded-t-2xl border-border/60">
        <DrawerTitle {...stylex.props(sheetSurface.srOnly)}>{heading}</DrawerTitle>
        <DrawerDescription {...stylex.props(sheetSurface.srOnly)}>{heading}</DrawerDescription>
        <div {...stylex.props(sheetSurface.body)}>
          {infoRows.length > 0 ? (
            /* Stacked label-over-value rows so every line starts at the same x
               regardless of label length; hairline dividers between rows. */
            <div {...stylex.props(sheetSurface.card, styles.infoCard)}>
              {infoRows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={row.onCopy ? () => run(row.onCopy!) : undefined}
                  disabled={!row.onCopy}
                  {...stylex.props(
                    sheetSurface.cardRow,
                    row.onCopy ? styles.infoRowCopyable : styles.infoRowPlain
                  )}
                >
                  <span {...stylex.props(styles.rowGlyph)}>{row.icon}</span>
                  <span {...stylex.props(styles.rowText)}>
                    <span {...stylex.props(styles.rowLabel)}>{row.label}</span>
                    <span {...stylex.props(styles.rowValueLine)}>
                      <span
                        {...stylex.props(
                          styles.rowValue,
                          row.wrapValue ? styles.rowValueWrap : styles.rowValueTruncate
                        )}
                      >
                        {row.value}
                      </span>
                      {row.trailing}
                    </span>
                  </span>
                  {row.onCopy ? (
                    <Copy {...stylex.props(styles.rowCopyGlyph)} aria-hidden="true" />
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}

          {owner ? (
            <div {...stylex.props(sheetSurface.card, styles.ownerCard)}>
              <button
                type="button"
                onClick={() => setOwnerListOpen((value) => !value)}
                aria-expanded={ownerListOpen}
                {...stylex.props(styles.ownerRow)}
              >
                <span {...stylex.props(styles.rowGlyph)}>
                  <UserRoundCog {...stylex.props(styles.ownerGlyph)} />
                </span>
                <span {...stylex.props(styles.rowText)}>
                  <span {...stylex.props(styles.rowLabel)}>
                    {t('sessions.owner.label', 'Owner')}
                  </span>
                  <span {...stylex.props(styles.rowValue, styles.rowValueTruncate)}>
                    {ownerName ?? t('sessions.owner.unknown', 'Unknown')}
                  </span>
                </span>
                <ChevronDown
                  {...stylex.props(styles.ownerChevron, ownerListOpen && styles.ownerChevronOpen)}
                  aria-hidden="true"
                />
              </button>
              {ownerListOpen ? (
                <div {...stylex.props(styles.ownerList)}>
                  {owner.members.map((member) => {
                    const isOwner = member.userId === owner.ownerUserId;
                    return (
                      <button
                        key={member.userId}
                        type="button"
                        onClick={() => {
                          if (!isOwner) run(() => owner.onSelect(member.userId));
                          else onOpenChange(false);
                        }}
                        {...stylex.props(styles.memberRow)}
                      >
                        <UserAvatar
                          user={{ id: member.userId, name: member.name, image: member.image }}
                          size="small"
                          className="shrink-0"
                        />
                        <span {...stylex.props(styles.memberName)}>{member.name}</span>
                        {isOwner ? (
                          <Check {...stylex.props(styles.ownerCheck)} aria-hidden="true" />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}

          <div {...stylex.props(styles.actions)}>
            {actions.map((action) => (
              <div key={action.id}>
                {action.separatorBefore ? <div {...stylex.props(styles.actionSeparator)} /> : null}
                <button
                  type="button"
                  onClick={() => run(action.onClick)}
                  disabled={action.disabled}
                  {...stylex.props(
                    styles.action,
                    action.destructive ? styles.actionDestructive : styles.actionIdle
                  )}
                >
                  <span {...stylex.props(styles.actionGlyph)}>{action.icon}</span>
                  <span {...stylex.props(styles.actionLabel)}>{action.label}</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

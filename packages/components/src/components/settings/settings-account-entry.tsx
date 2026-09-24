import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { duration, ease, space } from '@lody/ui/tokens/scales.stylex';
import { UserAvatar } from '@/components/user-avatar';
import { settingsSurface as surface } from './surface';

const styles = stylex.create({
  /**
   * On mobile the entry is a card of its own above the settings list, and the
   * whole card is the row a person opens. It restates the card's fill under
   * the pointer's, since a hover fill set elsewhere would replace the card's.
   */
  mobile: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    width: '100%',
    minWidth: 0,
    paddingInline: space[4],
    paddingBlock: space[3],
    margin: 0,
    borderWidth: 0,
    backgroundColor: {
      default: colors.elevatedBackground,
      ':hover': `color-mix(in oklab, ${colors.elevatedBackground}, ${colors.label} 4%)`,
    },
    color: colors.label,
    fontFamily: 'inherit',
    fontSize: '1em',
    textAlign: 'start',
    cursor: 'pointer',
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  mobileText: { flexGrow: 1, minWidth: 0 },
  mobileName: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.95em',
    fontWeight: 400,
    color: colors.label,
  },
  mobileEmail: {
    display: 'block',
    marginTop: '2px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.78em',
    color: colors.secondaryLabel,
  },
  chevron: { flexShrink: 0, width: '16px', height: '16px', color: colors.tertiaryLabel },
});

type SettingsAccountUser = {
  id?: string | null;
  name?: string | null;
  image?: string | null;
  email?: string | null;
};

export function SettingsAccountEntry({
  user,
  active = false,
  mobile = false,
  onSelect,
}: {
  user: SettingsAccountUser | null | undefined;
  active?: boolean;
  mobile?: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  if (!user) return null;

  const name = user.name || user.email || t('settings.tabs.account');

  if (mobile) {
    return (
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        aria-label={t('settings.account.open', 'Open account settings')}
        {...stylex.props(surface.card, styles.mobile)}
      >
        <UserAvatar user={user} size="large" />
        <span {...stylex.props(styles.mobileText)}>
          <span {...stylex.props(styles.mobileName)}>{name}</span>
          {user.email ? <span {...stylex.props(styles.mobileEmail)}>{user.email}</span> : null}
        </span>
        <ChevronRight {...stylex.props(styles.chevron)} aria-hidden="true" />
      </button>
    );
  }

  // On desktop the entry is one row of the settings nav, so it is that row.
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      aria-label={t('settings.account.open', 'Open account settings')}
      {...stylex.props(surface.listRow, active && surface.listRowSelected)}
    >
      <UserAvatar user={user} size="medium" />
      <span {...stylex.props(surface.listRowLabel)}>{name}</span>
    </button>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Users } from 'lucide-react';
import { SiDiscord } from 'react-icons/si';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, focus, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Button, Dialog } from '@/ui';
import { LODY_DISCORD_URL } from '@/lib/lody-urls';
import { openExternalUrl } from '@/lib/native-browser';
// The Feishu group QR ships with the app rather than being fetched from the
// server worker: About must render it on a desktop or mobile client that is
// offline or signed out, and the OSS desktop entry makes no product-cloud
// requests at all. Rotating the invite therefore means replacing this file.
import communityFeishuQrUrl from '@/assets/community-feishu-qr.png';

/**
 * Two ways in, side by side on the panel: each is a region of the modal, a fill
 * with no edge, and the Discord one answers the pointer because it is pressed.
 */
const styles = stylex.create({
  options: {
    display: 'grid',
    gridTemplateColumns: { default: '1fr', '@media (min-width: 640px)': 'repeat(2, 1fr)' },
    gap: space[3],
  },
  option: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[3],
    minHeight: '160px',
    margin: 0,
    padding: space[4],
    borderWidth: 0,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 3%)`,
    color: colors.label,
    fontFamily: 'inherit',
    textAlign: 'center',
  },
  optionPressable: {
    backgroundColor: {
      default: `color-mix(in oklab, transparent, ${colors.label} 3%)`,
      ':hover': `color-mix(in oklab, transparent, ${colors.label} 7%)`,
    },
    boxShadow: { default: 'none', ':focus-visible': `0 0 0 ${focus.ringWidth} ${colors.accent}` },
    outlineStyle: 'none',
    cursor: 'pointer',
    transitionProperty: 'background-color, box-shadow',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  // The white plate is not decoration: a QR inverted by a dark theme does not scan.
  qr: {
    width: '160px',
    height: '160px',
    objectFit: 'contain',
    backgroundColor: 'white',
    borderRadius: radius.small,
    cornerShape: corner.shape,
  },
  discordGlyph: { width: '32px', height: '32px', color: colors.secondaryLabel },
  optionText: { display: 'flex', flexDirection: 'column', gap: '2px' },
  optionTitle: { margin: 0, fontSize: text.bodySize, fontWeight: 400, color: colors.label },
  optionHint: { margin: 0, fontSize: text.footnoteSize, color: colors.secondaryLabel },
  icon: { width: '14px', height: '14px', flexShrink: 0 },
});

/**
 * The Join-community dialog itself: controlled, trigger-less, and mounted by
 * whichever surface opens it — the About settings button (`JoinCommunityButton`)
 * and the sidebar help menu (`JoinCommunityDialogContainer`) share this one
 * component so both routes look identical.
 */
export function JoinCommunityDialog({
  open,
  onOpenChange,
  qrImageUrl = communityFeishuQrUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Overridable so Storybook can pin a fixture instead of the bundled asset. */
  qrImageUrl?: string;
}) {
  const { t } = useTranslation();

  const handleJoinDiscord = () => {
    void openExternalUrl(LODY_DISCORD_URL);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>
            {t('settings.about.communityDialogTitle', 'Join the Lody community')}
          </Dialog.Title>
          <Dialog.Description>
            {t(
              'settings.about.communityDialogDescription',
              'Chat with the team and other users, get help, and share feedback.'
            )}
          </Dialog.Description>
        </Dialog.Header>
        <div {...stylex.props(styles.options)}>
          <div {...stylex.props(styles.option)}>
            <img
              src={qrImageUrl}
              alt={t('settings.about.feishuGroupQrAlt', 'Lody Feishu group QR code')}
              {...stylex.props(styles.qr)}
            />
            <div {...stylex.props(styles.optionText)}>
              <p {...stylex.props(styles.optionTitle)}>
                {t('settings.about.feishuGroup', 'Feishu group')}
              </p>
              <p {...stylex.props(styles.optionHint)}>
                {t(
                  'settings.about.feishuGroupHint',
                  'Scan the QR code with Feishu to join the group.'
                )}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleJoinDiscord}
            {...stylex.props(styles.option, styles.optionPressable)}
          >
            <SiDiscord {...stylex.props(styles.discordGlyph)} />
            <span {...stylex.props(styles.optionText)}>
              <span {...stylex.props(styles.optionTitle)}>
                {t('settings.about.joinDiscord', 'Join Discord')}
              </span>
              <span {...stylex.props(styles.optionHint)}>
                {t('settings.about.joinDiscordHint', 'Opens discord.gg in your browser.')}
              </span>
            </span>
          </button>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/**
 * Settings → About → Community entry. Highlighted (primary) rather than the
 * outline used by the neighbouring link rows, because it is the row we want
 * people to notice.
 */
export function JoinCommunityButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button size="small" onClick={() => setOpen(true)}>
        <Users {...stylex.props(styles.icon)} />
        {t('settings.about.joinCommunity', 'Join community')}
      </Button>
      <JoinCommunityDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

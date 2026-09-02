import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Users } from 'lucide-react';
import { SiDiscord } from 'react-icons/si';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui';
import { LODY_DISCORD_URL } from '@/lib/lody-urls';
import { openExternalUrl } from '@/lib/native-browser';
// The Feishu group QR ships with the app rather than being fetched from the
// server worker: About must render it on a desktop or mobile client that is
// offline or signed out, and the OSS desktop entry makes no product-cloud
// requests at all. Rotating the invite therefore means replacing this file.
import communityFeishuQrUrl from '@/assets/community-feishu-qr.png';

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t('settings.about.communityDialogTitle', 'Join the Lody community')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'settings.about.communityDialogDescription',
              'Chat with the team and other users, get help, and share feedback.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col items-center gap-3 rounded-lg border border-border/70 bg-card/70 p-4">
            {/* The white plate is not decoration: a QR inverted by a dark theme
               does not scan. */}
            <img
              src={qrImageUrl}
              alt={t('settings.about.feishuGroupQrAlt', 'Lody Feishu group QR code')}
              className="h-40 w-40 rounded-md bg-white object-contain"
            />
            <div className="text-center">
              <p className="text-sm font-medium text-foreground">
                {t('settings.about.feishuGroup', 'Feishu group')}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
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
            className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border border-border/70 bg-card/70 p-4 transition-colors hover:bg-hover"
          >
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
              <SiDiscord className="h-6 w-6 text-muted-foreground" />
            </span>
            <span className="text-sm font-medium text-foreground">
              {t('settings.about.joinDiscord', 'Join Discord')}
            </span>
            <span className="text-xs text-muted-foreground">
              {t('settings.about.joinDiscordHint', 'Opens discord.gg in your browser.')}
            </span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
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
        <Users className="mr-1 h-3.5 w-3.5" />
        {t('settings.about.joinCommunity', 'Join community')}
      </Button>
      <JoinCommunityDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

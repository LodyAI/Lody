import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Github, Loader2 } from 'lucide-react';

import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Card } from '@lody/ui/card';
import lodyLogo from '@/assets/lody-icon.png';

export interface DesktopGithubInstallPageProps {
  deepLink: string | null;
}

export function DesktopGithubInstallPage({ deepLink }: DesktopGithubInstallPageProps) {
  const { t } = useTranslation();
  const openLabel = t('desktopGithubInstall.openButton', 'Open Lody Desktop');

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-4">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-md"
      >
        <Card.Root>
          <HandoffVisual />
          <Card.Header className="items-center text-center">
            <Card.Title as="h1">
              {t('desktopGithubInstall.title', 'Continue in Lody Desktop')}
            </Card.Title>
            <Badge tone="running" icon={<Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}>
              {t('desktopGithubInstall.opening', 'Opening Lody Desktop…')}
            </Badge>
          </Card.Header>
          {deepLink ? (
            <Button render={<a href={deepLink} />} size="large" className="w-full">
              {openLabel}
            </Button>
          ) : (
            <Button size="large" className="w-full" disabled>
              {openLabel}
            </Button>
          )}
        </Card.Root>
      </motion.div>
    </div>
  );
}

function HandoffVisual() {
  return (
    <div className="flex items-center justify-center gap-5" aria-hidden="true">
      <span className="flex h-20 w-20 items-center justify-center rounded-[1.25rem] border border-border bg-muted/50 shadow-sm">
        <Github className="h-9 w-9 text-foreground" />
      </span>

      <ConnectorTrack />

      <span className="flex h-20 w-20 items-center justify-center rounded-[1.25rem] border border-primary/25 bg-primary/10 shadow-sm">
        <img src={lodyLogo} alt="Lody" className="h-14 w-14 object-contain" draggable={false} />
      </span>
    </div>
  );
}

function ConnectorTrack() {
  return (
    <div className="relative h-px w-12">
      <div className="absolute inset-0 top-1/2 h-px -translate-y-1/2 bg-gradient-to-r from-border via-primary/40 to-primary/60" />
      {[0, 1].map((index) => (
        <motion.span
          key={index}
          className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow-[0_0_10px_2px_hsl(var(--primary)/0.6)]"
          animate={{ left: ['0%', '100%'], opacity: [0, 1, 1, 0] }}
          transition={{
            duration: 1.6,
            repeat: Infinity,
            ease: 'easeInOut',
            delay: index * 0.8,
          }}
        />
      ))}
    </div>
  );
}

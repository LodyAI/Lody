import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Popover } from '@lody/ui/popover';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { settingsType as type } from './type.stylex';

const styles = stylex.create({
  icon: { width: '14px', height: '14px', strokeWidth: 1.75 },
  body: {
    boxSizing: 'border-box',
    maxWidth: '280px',
    margin: 0,
    padding: space[2],
    fontSize: text.footnoteSize,
    lineHeight: type.leading,
    fontWeight: 400,
    color: colors.secondaryLabel,
  },
});

export function SettingsInfo({ label, children }: { label: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={150}
        render={
          <Button
            variant="ghost"
            size="mini"
            icon
            aria-label={t('settings.info.about', { label })}
          />
        }
      >
        <Info aria-hidden="true" {...stylex.props(styles.icon)} />
      </Popover.Trigger>
      <Popover.Content side="bottom" align="start">
        <p {...stylex.props(styles.body)}>{children}</p>
      </Popover.Content>
    </Popover.Root>
  );
}

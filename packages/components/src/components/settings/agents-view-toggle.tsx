import { Gauge, List } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Tooltip } from '@lody/ui/tooltip';

export type AgentsView = 'configuration' | 'quota';

const ICON_ENTER = { type: 'tween', duration: 0.16, ease: 'easeOut' } as const;
const ICON_EXIT = { type: 'tween', duration: 0.12, ease: 'easeIn' } as const;
const SHOWN = { opacity: 1, filter: 'blur(0px)' };

const styles = stylex.create({
  slot: { display: 'grid', width: '16px', height: '16px' },
  icon: { display: 'flex', gridArea: '1 / 1', width: '16px', height: '16px' },
});

export function AgentsViewToggle({
  view,
  onChange,
}: {
  view: AgentsView;
  onChange: (view: AgentsView) => void;
}) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const quota = view === 'quota';
  const hidden = { opacity: 0, filter: reduceMotion === true ? 'blur(0px)' : 'blur(4px)' };
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <Button
            icon
            variant="ghost"
            size="small"
            aria-label={t('settings.agent.view.toggle', 'Switch configuration and quota views')}
            aria-pressed={quota}
            onClick={() => onChange(quota ? 'configuration' : 'quota')}
          />
        }
      >
        <span aria-hidden="true" {...stylex.props(styles.slot)}>
          <motion.span
            initial={false}
            animate={quota ? hidden : SHOWN}
            transition={quota ? ICON_EXIT : ICON_ENTER}
            {...stylex.props(styles.icon)}
          >
            <Gauge size={16} />
          </motion.span>
          <motion.span
            initial={false}
            animate={quota ? SHOWN : hidden}
            transition={quota ? ICON_ENTER : ICON_EXIT}
            {...stylex.props(styles.icon)}
          >
            <List size={16} />
          </motion.span>
        </span>
      </Tooltip.Trigger>
      <Tooltip.Content>
        {quota
          ? t('settings.agent.view.configuration', 'Configuration view')
          : t('settings.aiUsage.overview.quota', 'Account quota')}
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

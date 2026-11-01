import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text as type } from '@lody/ui/tokens/scales.stylex';
import { ChevronLeft, MonitorSmartphone, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

const styles = stylex.create({
  page: {
    minHeight: '100vh',
    overflowY: 'auto',
    backgroundColor: colors.background,
    color: colors.label,
    paddingBlock: space[6],
    paddingInline: { default: space[6], '@media (max-width: 520px)': space[4] },
    fontSize: type.bodySize,
    lineHeight: 1.45,
  },
  column: {
    maxWidth: 560,
    marginInline: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: space[6],
  },
  back: { marginInlineStart: `calc(-1 * ${space[2]})`, alignSelf: 'flex-start' },
  hero: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: space[3] },
  icon: { color: colors.secondaryLabel },
  title: { fontSize: type.titleSize, lineHeight: type.titleLeading, fontWeight: 600, margin: 0 },
  lead: { margin: 0, color: colors.secondaryLabel },
  steps: {
    margin: 0,
    paddingInlineStart: space[4],
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    color: colors.secondaryLabel,
  },
  note: {
    margin: 0,
    padding: space[4],
    borderRadius: radius.large,
    backgroundColor: colors.secondaryBackground,
    color: colors.secondaryLabel,
    fontSize: type.subheadlineSize,
  },
  actions: { display: 'flex', flexWrap: 'wrap', gap: space[2] },
});

export interface E2eeDeviceApprovalGuideProps {
  /** Why approval is needed: a new device, or one whose earlier identity was revoked. */
  reason?: 'new' | 'revoked';
  /** Re-reads this device's approval state; the page never approves anything itself. */
  onRefresh: () => void;
  /** Opens the full ledger and diagnostics view. */
  onShowDetails: () => void;
  onBack: () => void;
  refreshing?: boolean;
  /** The existing explicit pairing exchange, kept during the transition. */
  children?: ReactNode;
}

/**
 * Landing page for a signed-in device that has no approved identity in this
 * encrypted workspace. It only explains the next step; approval still comes from
 * an already approved personal device, and ledger details live behind "Details".
 */
export function E2eeDeviceApprovalGuide(props: E2eeDeviceApprovalGuideProps) {
  const { t } = useTranslation();
  return (
    <main
      data-testid="e2ee-device-approval-guide"
      data-control-state="approval-required"
      {...stylex.props(styles.page)}
    >
      <div {...stylex.props(styles.column)}>
        <Button variant="ghost" size="small" onClick={props.onBack} {...stylex.props(styles.back)}>
          <ChevronLeft size={14} aria-hidden="true" />
          {t('e2ee.control.back')}
        </Button>
        <header {...stylex.props(styles.hero)}>
          <MonitorSmartphone size={28} aria-hidden="true" {...stylex.props(styles.icon)} />
          <h1 {...stylex.props(styles.title)}>{t('e2ee.approvalGuide.title')}</h1>
          <p {...stylex.props(styles.lead)}>
            {t(
              props.reason === 'revoked' ? 'e2ee.approvalGuide.revoked' : 'e2ee.approvalGuide.lead'
            )}
          </p>
        </header>
        <ol {...stylex.props(styles.steps)}>
          <li>{t('e2ee.approvalGuide.stepOpen')}</li>
          <li>{t('e2ee.approvalGuide.stepAdd')}</li>
          <li>{t('e2ee.approvalGuide.stepCompare')}</li>
        </ol>
        <p {...stylex.props(styles.note)}>{t('e2ee.approvalGuide.noDevice')}</p>
        <div {...stylex.props(styles.actions)}>
          <Button variant="secondary" disabled={props.refreshing} onClick={props.onRefresh}>
            <RefreshCw size={14} aria-hidden="true" />
            {t('e2ee.approvalGuide.refresh')}
          </Button>
          <Button variant="ghost" onClick={props.onShowDetails}>
            {t('e2ee.approvalGuide.details')}
          </Button>
        </div>
        {props.children}
      </div>
    </main>
  );
}

import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import type { PendingE2eeWorkspace } from '@/lib/e2ee-workspace-storage';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { shadow } from '@lody/ui/tokens/colors.stylex';
import { Cloud, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const styles = stylex.create({
  section: {
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
    paddingTop: space[4],
  },
  heading: {
    margin: 0,
    marginBottom: space[2],
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
  },
  choices: {
    display: 'grid',
    gridTemplateColumns: { default: '1fr 1fr', '@media (max-width: 420px)': '1fr' },
    gap: space[2],
  },
  choice: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space[1.5],
    padding: space[3],
    borderRadius: radius.large,
    borderWidth: 0,
    backgroundColor: colors.secondaryBackground,
    boxShadow: 'none',
    color: colors.label,
    font: 'inherit',
    textAlign: 'start',
    cursor: { default: 'pointer', ':disabled': 'default' },
    opacity: { default: 1, ':disabled': 0.5 },
  },
  choiceOn: {
    backgroundColor: colors.elevatedBackground,
    boxShadow: `${shadow.card}, 0 0 0 2px ${colors.label}`,
  },
  choiceTitle: { display: 'flex', alignItems: 'center', gap: space[1.5], fontWeight: 600 },
  choiceList: {
    margin: 0,
    paddingInlineStart: space[4],
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: 1.6,
  },
  help: { color: colors.secondaryLabel, fontSize: '0.9em', lineHeight: 1.5, marginTop: space[2] },
  requests: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space[2],
    marginTop: space[3],
  },
});

export function E2eeWorkspaceCreationOption(props: {
  selected: boolean;
  supported: boolean;
  pending: boolean;
  disabled: boolean;
  paidRequired: boolean;
  onChange: (selected: boolean) => void;
  requests?: PendingE2eeWorkspace[];
  selectedRequestId?: string | null;
  onSelectRequest?: (requestId: string) => void;
  onNewRequest?: () => void;
  /** Stop resuming the selected saved request (kept in the list) and edit freely. */
  onSetAside?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section {...stylex.props(styles.section)}>
      <p id="e2ee-workspace-mode" {...stylex.props(styles.heading)}>
        {t('e2ee.create.label')}
      </p>
      <div
        role="radiogroup"
        aria-labelledby="e2ee-workspace-mode"
        {...stylex.props(styles.choices)}
      >
        <button
          type="button"
          role="radio"
          aria-checked={!props.selected}
          disabled={props.disabled || props.pending}
          onClick={() => props.onChange(false)}
          {...stylex.props(styles.choice, !props.selected && styles.choiceOn)}
        >
          <span {...stylex.props(styles.choiceTitle)}>
            <Cloud size={15} aria-hidden="true" />
            {t('e2ee.create.standard')}
          </span>
          <ul {...stylex.props(styles.choiceList)}>
            <li>{t('e2ee.create.standardPoint1')}</li>
            <li>{t('e2ee.create.standardPoint2')}</li>
          </ul>
        </button>
        <button
          type="button"
          role="radio"
          // Kept stable for automation that selects encryption by this id.
          id="e2ee-workspace-create"
          data-testid="e2ee-workspace-create"
          aria-checked={props.selected}
          disabled={props.disabled || props.pending || !props.supported}
          onClick={() => props.onChange(true)}
          {...stylex.props(styles.choice, props.selected && styles.choiceOn)}
        >
          <span {...stylex.props(styles.choiceTitle)}>
            <Lock size={15} aria-hidden="true" />
            {t('e2ee.create.encrypted')}
          </span>
          <ul {...stylex.props(styles.choiceList)}>
            <li>{t('e2ee.create.encryptedPoint1')}</li>
            <li>{t('e2ee.create.encryptedPoint2')}</li>
            <li>{t('e2ee.create.encryptedPoint3')}</li>
          </ul>
        </button>
      </div>
      <p {...stylex.props(styles.help)}>{t('e2ee.create.description')}</p>
      {!props.supported && <p {...stylex.props(styles.help)}>{t('e2ee.create.unsupported')}</p>}
      {props.pending && (
        <p role="status" {...stylex.props(styles.help)}>
          {t('e2ee.create.pending')}
        </p>
      )}
      {Boolean(props.requests?.length) && (
        <div {...stylex.props(styles.requests)}>
          <p>{t('e2ee.create.savedRequests')}</p>
          {props.requests?.map((request) => (
            <Button
              key={request.requestId}
              variant="secondary"
              aria-pressed={props.selectedRequestId === request.requestId}
              disabled={props.disabled}
              onClick={() => props.onSelectRequest?.(request.requestId)}
            >
              {request.name} · {request.slug}
            </Button>
          ))}
          {props.onNewRequest && (
            <Button variant="ghost" disabled={props.disabled} onClick={props.onNewRequest}>
              {t('e2ee.create.newRequest')}
            </Button>
          )}
          {props.onSetAside && (
            <Button variant="ghost" disabled={props.disabled} onClick={props.onSetAside}>
              {t('e2ee.create.setAside')}
            </Button>
          )}
        </div>
      )}
      {props.selected && props.paidRequired && !props.pending && (
        <p {...stylex.props(styles.help)}>{t('e2ee.create.paidUnavailable')}</p>
      )}
    </section>
  );
}

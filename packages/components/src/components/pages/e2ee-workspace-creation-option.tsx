import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import type { PendingE2eeWorkspace } from '@/lib/e2ee-workspace-storage';
import { E2eeCreationRequestList } from './e2ee-creation-request-list';
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
  warning: { color: colors.warning },
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
  /** Automation id of the encrypted choice; a host keeps its established id. */
  encryptedChoiceTestId?: string;
  requests?: PendingE2eeWorkspace[];
  /** Saved requests the user archived: hidden from the default list, restorable. */
  archivedRequests?: PendingE2eeWorkspace[];
  selectedRequestId?: string | null;
  onSelectRequest?: (requestId: string) => void;
  onArchiveRequest?: (requestId: string) => void;
  onRestoreRequest?: (requestId: string) => void;
  onDeleteRequest?: (requestId: string) => void;
  deletingRequestId?: string | null;
  defaultArchiveOpen?: boolean;
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
          id={props.encryptedChoiceTestId ?? 'e2ee-workspace-create'}
          data-testid={props.encryptedChoiceTestId ?? 'e2ee-workspace-create'}
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
      {props.selected && (
        <p role="note" {...stylex.props(styles.help, styles.warning)}>
          {t('e2ee.create.lossWarning')}
        </p>
      )}
      <p {...stylex.props(styles.help)}>{t('e2ee.create.description')}</p>
      {!props.supported && <p {...stylex.props(styles.help)}>{t('e2ee.create.unsupported')}</p>}
      {props.pending && (
        <p role="status" {...stylex.props(styles.help)}>
          {t('e2ee.create.pending')}
        </p>
      )}
      {Boolean(props.requests?.length || props.archivedRequests?.length) && (
        <div {...stylex.props(styles.requests)}>
          <E2eeCreationRequestList
            requests={props.requests ?? []}
            archivedRequests={props.archivedRequests ?? []}
            selectedRequestId={props.selectedRequestId ?? null}
            disabled={props.disabled}
            defaultArchiveOpen={props.defaultArchiveOpen}
            onSelectRequest={(requestId) => props.onSelectRequest?.(requestId)}
            onArchiveRequest={(requestId) => props.onArchiveRequest?.(requestId)}
            onRestoreRequest={(requestId) => props.onRestoreRequest?.(requestId)}
            onDeleteRequest={(requestId) => props.onDeleteRequest?.(requestId)}
            deletingRequestId={props.deletingRequestId ?? null}
          />
          {props.onNewRequest && (
            <Button
              variant="ghost"
              disabled={props.disabled || Boolean(props.deletingRequestId)}
              onClick={props.onNewRequest}
            >
              {t('e2ee.create.newRequest')}
            </Button>
          )}
          {props.onSetAside && (
            <Button
              variant="ghost"
              disabled={props.disabled || Boolean(props.deletingRequestId)}
              onClick={props.onSetAside}
            >
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

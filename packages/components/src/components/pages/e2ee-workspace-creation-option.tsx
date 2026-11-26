import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import type { PendingE2eeWorkspace } from '@/lib/e2ee-workspace-storage';
import { E2eeCreationRequestList } from './e2ee-creation-request-list';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Check, Cloud, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const styles = stylex.create({
  section: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
    paddingTop: space[3],
  },
  heading: {
    margin: 0,
    marginBottom: space[2],
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    fontWeight: 500,
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
    paddingBlock: '10px',
    paddingInline: space[3],
    borderRadius: radius.medium,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.separator,
    backgroundColor: { default: colors.secondaryBackground, ':hover': colors.hoverFill },
    boxShadow: 'none',
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    font: 'inherit',
    textAlign: 'start',
    cursor: { default: 'pointer', ':disabled': 'default' },
    transitionProperty: 'background-color, border-color, color, box-shadow',
    transitionDuration: '120ms',
  },
  choiceOn: {
    backgroundColor: { default: colors.elevatedBackground, ':hover': colors.elevatedBackground },
    borderColor: colors.label,
    boxShadow: shadow.card,
    color: { default: colors.label, ':hover': colors.label },
  },
  choiceDimmed: {
    opacity: 0.45,
  },
  choiceHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    width: '100%',
  },
  choiceTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    fontSize: text.subheadlineSize,
    fontWeight: 600,
  },
  checkBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    borderRadius: radius.full,
    backgroundColor: colors.label,
    color: colors.background,
    flexShrink: 0,
  },
  choiceList: {
    margin: 0,
    paddingInlineStart: space[4],
    listStyleType: 'disc',
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: 1.5,
  },
  warning: { color: colors.warning },
  help: {
    margin: 0,
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: 1.45,
    marginTop: space[1.5],
  },
  requests: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space[2],
    marginTop: space[3],
  },
  requestsTop: {
    marginTop: 0,
    marginBottom: space[4],
    paddingBottom: space[4],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
  },
  requestActions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: space[2],
    marginTop: space[1],
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
  const hasSavedRequests = Boolean(props.requests?.length || props.archivedRequests?.length);
  const requestsBlock = hasSavedRequests ? (
    <div {...stylex.props(styles.requests, props.pending && styles.requestsTop)}>
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
      {(props.onNewRequest || props.onSetAside) && (
        <div {...stylex.props(styles.requestActions)}>
          {props.onNewRequest && (
            <Button
              variant="secondary"
              size="small"
              disabled={props.disabled || Boolean(props.deletingRequestId)}
              onClick={props.onNewRequest}
            >
              {t('e2ee.create.newRequest')}
            </Button>
          )}
          {props.onSetAside && (
            <Button
              variant="ghost"
              size="small"
              disabled={props.disabled || Boolean(props.deletingRequestId)}
              onClick={props.onSetAside}
            >
              {t('e2ee.create.setAside')}
            </Button>
          )}
        </div>
      )}
    </div>
  ) : null;
  return (
    <section {...stylex.props(styles.section)}>
      {props.pending && requestsBlock}
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
          disabled={props.disabled}
          onClick={() => props.onChange(false)}
          {...stylex.props(
            styles.choice,
            !props.selected && styles.choiceOn,
            props.disabled && styles.choiceDimmed
          )}
        >
          <span {...stylex.props(styles.choiceHeader)}>
            <span {...stylex.props(styles.choiceTitle)}>
              <Cloud size={15} aria-hidden="true" />
              {t('e2ee.create.standard')}
            </span>
            {!props.selected && (
              <span aria-hidden="true" {...stylex.props(styles.checkBadge)}>
                <Check size={10} strokeWidth={2.5} />
              </span>
            )}
          </span>
          {!props.pending && (
            <ul {...stylex.props(styles.choiceList)}>
              <li>{t('e2ee.create.standardPoint1')}</li>
              <li>{t('e2ee.create.standardPoint2')}</li>
            </ul>
          )}
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
          {...stylex.props(
            styles.choice,
            props.selected && styles.choiceOn,
            (props.disabled || !props.supported) && styles.choiceDimmed
          )}
        >
          <span {...stylex.props(styles.choiceHeader)}>
            <span {...stylex.props(styles.choiceTitle)}>
              <Lock size={15} aria-hidden="true" />
              {t('e2ee.create.encrypted')}
            </span>
            {props.selected && (
              <span aria-hidden="true" {...stylex.props(styles.checkBadge)}>
                <Check size={10} strokeWidth={2.5} />
              </span>
            )}
          </span>
          {!props.pending && (
            <ul {...stylex.props(styles.choiceList)}>
              <li>{t('e2ee.create.encryptedPoint1')}</li>
              <li>{t('e2ee.create.encryptedPoint2')}</li>
              <li>{t('e2ee.create.encryptedPoint3')}</li>
            </ul>
          )}
        </button>
      </div>
      {props.selected && !props.pending && (
        <p role="note" {...stylex.props(styles.help, styles.warning)}>
          {t('e2ee.create.lossWarning')}
        </p>
      )}
      {props.selected && props.supported && (
        <p {...stylex.props(styles.help)}>{t('e2ee.create.description')}</p>
      )}
      {!props.supported && <p {...stylex.props(styles.help)}>{t('e2ee.create.unsupported')}</p>}
      {props.pending && (
        <p role="status" {...stylex.props(styles.help)}>
          {t('e2ee.create.pending')}
        </p>
      )}
      {!props.pending && requestsBlock}
      {props.selected && props.paidRequired && !props.pending && (
        <p {...stylex.props(styles.help)}>{t('e2ee.create.paidUnavailable')}</p>
      )}
    </section>
  );
}

import * as stylex from '@stylexjs/stylex';
import { Switch } from '@lody/ui/switch';
import { Button } from '@lody/ui/button';
import type { PendingE2eeWorkspace } from '@/lib/e2ee-workspace-storage';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { useTranslation } from 'react-i18next';

const styles = stylex.create({
  section: {
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
    paddingTop: space[4],
  },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space[3] },
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
      <div {...stylex.props(styles.row)}>
        <label htmlFor="e2ee-workspace-create">{t('e2ee.create.label')}</label>
        <Switch
          id="e2ee-workspace-create"
          checked={props.selected}
          disabled={props.disabled || props.pending || !props.supported}
          onCheckedChange={props.onChange}
        />
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

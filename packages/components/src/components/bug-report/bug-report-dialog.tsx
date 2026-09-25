import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleCheck } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Spinner } from '@lody/ui/spinner';
import type { MachineId } from '@lody/shared';
import { Dialog } from '@/ui/dialog';
import { Button } from '@lody/ui/button';
import { Field as UiField } from '@lody/ui/field';
import { Textarea } from '@lody/ui/textarea';
import { CopyButton } from '@/ui/copy-button';
import { Select } from '@lody/ui/select';

export type BugReportMachineOption = {
  id: MachineId;
  name: string;
};

export type BugReportSubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'success'; bugReportId: string; withLogs: boolean }
  | { status: 'error'; message: string };

export type BugReportDialogProps = {
  open: boolean;
  /** Online machines only — offline machines cannot upload logs anyway. */
  machines: BugReportMachineOption[];
  /** Machine preselected when the dialog opens (e.g. the user's most recently used online machine). */
  initialMachineId?: MachineId | null;
  state: BugReportSubmitState;
  /** `machineId: null` files a description-only report without machine logs. */
  onSubmit: (args: { machineId: MachineId | null; description: string }) => void;
  onClose: () => void;
};

const NO_MACHINE_VALUE = '__no_machine__';

const styles = stylex.create({
  option: { display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  optionLabel: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  dot: {
    boxSizing: 'border-box',
    flexShrink: 0,
    width: '8px',
    height: '8px',
    borderRadius: radius.full,
  },
  /** No machine: an empty ring in the hint colour, nothing live to report. */
  dotNone: { boxShadow: `inset 0 0 0 1px ${colors.tertiaryLabel}` },
  dotOnline: { backgroundColor: colors.success },
  title: { display: 'flex', alignItems: 'center', gap: space[2] },
  titleMark: { flexShrink: 0, width: '20px', height: '20px', color: colors.success },
  /** The report ID: a region fill inside the panel, no edge. */
  reportId: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    paddingBlock: space[1],
    paddingInlineStart: space[3],
    paddingInlineEnd: space[1],
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 3%)`,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
  },
  reportIdText: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.subheadlineSize,
    color: colors.label,
  },
  body: { display: 'grid', gap: space[4] },
  field: { display: 'grid', gap: space[1.5] },
  hint: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  error: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.destructive,
  },
});

export function BugReportDialog({
  open,
  machines,
  initialMachineId,
  state,
  onSubmit,
  onClose,
}: BugReportDialogProps) {
  const { t } = useTranslation();
  const [description, setDescription] = useState('');
  const [selectedMachineId, setSelectedMachineId] = useState<MachineId | null>(null);

  useEffect(() => {
    if (open) {
      setDescription('');
      setSelectedMachineId(initialMachineId ?? null);
    }
    // Reset only when the dialog opens; the initial selection must not
    // override a manual pick while it stays open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const machineId =
    selectedMachineId != null && machines.some((machine) => machine.id === selectedMachineId)
      ? selectedMachineId
      : null;
  // `Select.Value` reads the label of the current value from `items` rather than
  // from the rows, so the online dot travels with the name to the trigger only
  // because both come from here.
  const machineOptions = useMemo(
    () => [
      {
        value: NO_MACHINE_VALUE,
        label: (
          <span {...stylex.props(styles.option)}>
            <span {...stylex.props(styles.dot, styles.dotNone)} />
            <span {...stylex.props(styles.optionLabel)}>
              {t('bugReport.noMachineOption', 'No machine (description only)')}
            </span>
          </span>
        ),
      },
      ...machines.map((machine) => ({
        value: machine.id as string,
        label: (
          <span {...stylex.props(styles.option)}>
            <span {...stylex.props(styles.dot, styles.dotOnline)} />
            <span {...stylex.props(styles.optionLabel)}>{machine.name}</span>
          </span>
        ),
      })),
    ],
    [machines, t]
  );

  const submitting = state.status === 'submitting';
  const canSubmit = !submitting && description.trim().length > 0;

  const handleOpenChange = (nextOpen: boolean) => {
    // Closing is always an explicit user action; the success panel stays up
    // until then. Only block dismissal while logs are still uploading.
    if (!nextOpen && !submitting) {
      onClose();
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Content>
        {state.status === 'success' ? (
          <>
            <Dialog.Header>
              <Dialog.Title>
                <span {...stylex.props(styles.title)}>
                  <CircleCheck {...stylex.props(styles.titleMark)} />
                  {t('bugReport.successTitle', 'Bug report uploaded')}
                </span>
              </Dialog.Title>
              <Dialog.Description>
                {state.withLogs
                  ? t(
                      'bugReport.successDescription',
                      'The machine logs and your description were uploaded. Share this bug report ID with the Lody team:'
                    )
                  : t(
                      'bugReport.successDescriptionNoLogs',
                      'Your description was uploaded. Share this bug report ID with the Lody team:'
                    )}
              </Dialog.Description>
            </Dialog.Header>
            <div {...stylex.props(styles.reportId)}>
              <code {...stylex.props(styles.reportIdText)}>{state.bugReportId}</code>
              <CopyButton value={state.bugReportId} />
            </div>
            <Dialog.Footer>
              <Button onClick={onClose}>{t('bugReport.close', 'Close')}</Button>
            </Dialog.Footer>
          </>
        ) : (
          <>
            <Dialog.Header>
              <Dialog.Title>{t('bugReport.title', 'Report a bug')}</Dialog.Title>
              <Dialog.Description>
                {t(
                  'bugReport.dialogDescription',
                  "Describe the bug and pick the machine where it happened. Lody uploads that machine's logs from today and yesterday along with your description."
                )}
              </Dialog.Description>
              <p {...stylex.props(styles.hint)}>
                {t(
                  'bugReport.buildInfoIncluded',
                  'Reports include the current app version and build information.'
                )}
              </p>
            </Dialog.Header>
            <div {...stylex.props(styles.body)}>
              <div {...stylex.props(styles.field)}>
                <UiField.Label htmlFor="bug-report-description">
                  {t('bugReport.descriptionLabel', 'What happened?')}
                </UiField.Label>
                <Textarea
                  id="bug-report-description"
                  value={description}
                  disabled={submitting}
                  rows={5}
                  placeholder={t(
                    'bugReport.descriptionPlaceholder',
                    'Describe what you did and what went wrong...'
                  )}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
              <div {...stylex.props(styles.field)}>
                <UiField.Label htmlFor="bug-report-machine">
                  {t('bugReport.machineLabel', 'Machine')}
                </UiField.Label>
                {machines.length === 0 ? (
                  <p {...stylex.props(styles.hint)}>
                    {t(
                      'bugReport.noMachines',
                      'No machines are online — only your description will be uploaded.'
                    )}
                  </p>
                ) : (
                  <>
                    <Select.Root
                      items={machineOptions}
                      value={machineId ?? NO_MACHINE_VALUE}
                      disabled={submitting}
                      onValueChange={(value) =>
                        setSelectedMachineId(
                          value === NO_MACHINE_VALUE ? null : (value as MachineId)
                        )
                      }
                    >
                      <Select.Trigger id="bug-report-machine">
                        <Select.Value
                          placeholder={t('bugReport.machinePlaceholder', 'Select a machine')}
                        />
                      </Select.Trigger>
                      <Select.Content>
                        {machineOptions.map((option) => (
                          <Select.Item key={option.value} value={option.value}>
                            {option.label}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Root>
                    {machineId == null ? (
                      <p {...stylex.props(styles.hint)}>
                        {t(
                          'bugReport.noMachineHint',
                          'No machine selected — only your description will be uploaded.'
                        )}
                      </p>
                    ) : null}
                  </>
                )}
              </div>
              {state.status === 'error' ? (
                <p {...stylex.props(styles.error)}>{state.message}</p>
              ) : null}
            </div>
            <Dialog.Footer>
              <Button variant="secondary" disabled={submitting} onClick={onClose}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                disabled={!canSubmit}
                onClick={() => {
                  if (description.trim()) {
                    onSubmit({ machineId, description: description.trim() });
                  }
                }}
              >
                {submitting ? (
                  <>
                    <Spinner size="small" />
                    {machineId != null
                      ? t('bugReport.submitting', 'Uploading logs...')
                      : t('bugReport.submittingNoLogs', 'Submitting...')}
                  </>
                ) : machineId != null ? (
                  t('bugReport.submit', 'Share logs')
                ) : (
                  t('bugReport.submitNoLogs', 'Submit report')
                )}
              </Button>
            </Dialog.Footer>
          </>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}

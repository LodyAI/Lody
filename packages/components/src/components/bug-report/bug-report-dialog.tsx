import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleCheck, Loader2 } from 'lucide-react';
import type { MachineId } from '@lody/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Button } from '@lody/ui/button';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { CopyButton } from '@/ui/copy-button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';

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
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        {state.status === 'success' ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CircleCheck className="h-5 w-5 text-green-500" />
                {t('bugReport.successTitle', 'Bug report uploaded')}
              </DialogTitle>
              <DialogDescription>
                {state.withLogs
                  ? t(
                      'bugReport.successDescription',
                      'The machine logs and your description were uploaded. Share this bug report ID with the Lody team:'
                    )
                  : t(
                      'bugReport.successDescriptionNoLogs',
                      'Your description was uploaded. Share this bug report ID with the Lody team:'
                    )}
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2 rounded-md border bg-muted/50 py-1 pl-3 pr-1">
              <code className="min-w-0 flex-1 truncate text-sm">{state.bugReportId}</code>
              <CopyButton value={state.bugReportId} />
            </div>
            <DialogFooter>
              <Button onClick={onClose}>{t('bugReport.close', 'Close')}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('bugReport.title', 'Report a bug')}</DialogTitle>
              <DialogDescription>
                {t(
                  'bugReport.dialogDescription',
                  "Describe the bug and pick the machine where it happened. Lody uploads that machine's logs from today and yesterday along with your description."
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="bug-report-description">
                  {t('bugReport.descriptionLabel', 'What happened?')}
                </Label>
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
              <div className="grid gap-2">
                <Label htmlFor="bug-report-machine">{t('bugReport.machineLabel', 'Machine')}</Label>
                {machines.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t(
                      'bugReport.noMachines',
                      'No machines are online — only your description will be uploaded.'
                    )}
                  </p>
                ) : (
                  <>
                    <Select
                      value={machineId ?? NO_MACHINE_VALUE}
                      disabled={submitting}
                      onValueChange={(value) =>
                        setSelectedMachineId(
                          value === NO_MACHINE_VALUE ? null : (value as MachineId)
                        )
                      }
                    >
                      <SelectTrigger id="bug-report-machine">
                        <SelectValue
                          placeholder={t('bugReport.machinePlaceholder', 'Select a machine')}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_MACHINE_VALUE}>
                          <span className="flex items-center gap-2">
                            <span className="h-2 w-2 shrink-0 rounded-full border border-muted-foreground/50" />
                            <span className="truncate">
                              {t('bugReport.noMachineOption', 'No machine (description only)')}
                            </span>
                          </span>
                        </SelectItem>
                        {machines.map((machine) => (
                          <SelectItem key={machine.id} value={machine.id}>
                            <span className="flex items-center gap-2">
                              <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" />
                              <span className="truncate">{machine.name}</span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {machineId == null ? (
                      <p className="text-sm text-muted-foreground">
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
                <p className="text-sm text-destructive">{state.message}</p>
              ) : null}
            </div>
            <DialogFooter>
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
                    <Loader2 className="h-4 w-4 animate-spin" />
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
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

import { useTranslation } from 'react-i18next';
import type { ScheduleDocument, ScheduleRuntimeRow } from '@lody/shared';
import { Dialog } from '@/ui/dialog';
import { ScheduledMessageEditor } from './scheduled-message-editor';

/**
 * The in-conversation editor for a pending scheduled message. It edits the
 * complete message and its send time without leaving the chat; the schedule
 * page remains a separate surface for history and management.
 */
export function ScheduledMessageEditDialog({
  document,
  state,
  disabledReason,
  onCancel,
  onClose,
  onSaved,
}: {
  document: ScheduleDocument;
  state?: ScheduleRuntimeRow['messageState'];
  disabledReason?: string;
  onCancel: () => Promise<void>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Content width="42rem" className="max-h-[85dvh] overflow-y-auto">
        <Dialog.Header>
          <Dialog.Title>{t('scheduledMessage.editTitle', 'Edit scheduled message')}</Dialog.Title>
        </Dialog.Header>
        <ScheduledMessageEditor
          document={document}
          state={state}
          disabledReason={disabledReason}
          sent={false}
          onCancel={onCancel}
          onSaved={onSaved}
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}

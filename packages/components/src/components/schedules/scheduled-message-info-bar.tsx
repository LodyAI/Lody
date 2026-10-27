import { useState } from 'react';
import type { MachineMeta, SessionMeta } from '@lody/shared';
import { SessionInfoBar, type SessionInfoBarProps } from '../sessions/session-info-bar';
import { useScheduledMessageDraft } from './use-scheduled-message';
import { ScheduledMessageInfoChip, ScheduledMessageTimeDialog } from './scheduled-message-time';

/** Draft time changes are rare; keep their subscription local to the info bar. */
export function ScheduledMessageInfoBar({
  session,
  machineMeta,
  ...props
}: SessionInfoBarProps & {
  session: SessionMeta;
  machineMeta: MachineMeta | null | undefined;
}) {
  const draft = useScheduledMessageDraft(session, machineMeta);
  const [pickerKey, setPickerKey] = useState<string | null>(null);
  const visible = draft.available && !!draft.at && !session.isArchived;
  return (
    <>
      <SessionInfoBar
        {...props}
        scheduledMessage={
          visible ? (
            <ScheduledMessageInfoChip
              at={draft.at!}
              timeZone={draft.timeZone}
              disabled={draft.saving}
              onEdit={() => setPickerKey(draft.key)}
            />
          ) : null
        }
      />
      {visible && pickerKey === draft.key && !draft.saving ? (
        <ScheduledMessageTimeDialog
          at={draft.at}
          timeZone={draft.timeZone}
          onClose={() => setPickerKey(null)}
          onApply={(at) => {
            draft.apply(at);
            setPickerKey(null);
          }}
          onRemoveTime={() => {
            draft.cancel();
            setPickerKey(null);
          }}
        />
      ) : null}
    </>
  );
}

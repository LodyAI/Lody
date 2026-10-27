import { space } from '@lody/ui/tokens/scales.stylex';
import { useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Textarea } from '@lody/ui/textarea';
import { Button } from '@lody/ui/button';
import { Clock } from 'lucide-react';
import {
  SESSION_FILE_MAX_COUNT,
  SESSION_IMAGE_MAX_COUNT,
  getDeviceTimeZone,
  getServerNow,
  type ScheduleDocument,
  type ScheduleRuntimeRow,
  type MachineId,
  type SessionId,
  type SessionInputBlock,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom, authTokenAtom } from '@/atoms/runtime';
import { userAtom } from '@/atoms';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';
import { useResolvedMachineMeta } from '@/hooks/use-resolved-machine-meta';
import { ChatComposer } from '@/components/chat/chat-composer';
import { formatFileSize } from '@/lib/session-file-presentation';
import { splitImageAndFileAttachments } from '@/lib/file-drop';
import { validateSessionFile } from '@/lib/session-file-upload';
import { validateSessionImageFile } from '@/lib/session-image-upload';
import type { SessionAttachmentDraft } from '@/lib/session-attachment-draft';
import { ScheduledMessageTimeFields } from './scheduled-message-time';
import { prepareScheduledMessage, saveScheduledMessage } from './scheduled-message-write';

const styles = stylex.create({
  layout: { display: 'flex', flexDirection: 'column', gap: space[4], padding: space[4] },
  notice: { margin: 0, fontSize: '0.85em' },
  hidden: { display: 'none' },
});

/** Full-message tasks retain their target and rule; their payload never goes through the prompt-only editor. */
export function ScheduledMessageEditor({
  document,
  disabledReason,
  sent,
  state,
  onCancel,
  onSaved,
}: {
  document: ScheduleDocument;
  disabledReason?: string;
  sent: boolean;
  state?: ScheduleRuntimeRow['messageState'];
  onCancel: () => Promise<void>;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const active = useAtomValue(activeWorkspaceRuntimeAtom);
  const scope = useResolvedWorkspaceScope();
  const runtime = scope.enabled && active?.workspaceId === scope.workspaceId ? active : null;
  const user = useAtomValue(userAtom);
  const token = useAtomValue(authTokenAtom);
  const localMachineId = useAtomValue(localMachineIdAtom);
  const { machine } = useResolvedMachineMeta(document.definition.machineId as MachineId);
  const [text, setText] = useState(document.prompt);
  const [blocks, setBlocks] = useState(document.message?.inputBlocks ?? []);
  const [attachments, setAttachments] = useState<SessionAttachmentDraft[]>([]);
  const [at, setAt] = useState(
    document.definition.trigger.kind === 'once' ? document.definition.trigger.at : ''
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [identity] = useState(() => ({
    activationId: crypto.randomUUID(),
    activityId: crypto.randomUUID(),
  }));
  const disabled = saving || !!disabledReason || sent || !document.definition.enabled;
  const add = (files: File[]) => {
    const { images, attachments: filesOnly } = splitImageAndFileAttachments(files);
    const next: SessionAttachmentDraft[] = [];
    let imageCount =
      blocks.filter((block) => block.type === 'image').length +
      attachments.filter((item) => item.kind === 'image').length;
    let fileCount =
      blocks.filter((block) => block.type === 'file').length +
      attachments.filter((item) => item.kind === 'file').length;
    for (const file of [...images, ...filesOnly]) {
      const kind = images.includes(file) ? 'image' : 'file';
      if (kind === 'image' ? validateSessionImageFile(file) : validateSessionFile(file)) {
        setError(t('scheduledMessage.invalidAttachment'));
        continue;
      }
      if (
        (kind === 'image' && imageCount >= SESSION_IMAGE_MAX_COUNT) ||
        (kind === 'file' && fileCount >= SESSION_FILE_MAX_COUNT)
      ) {
        setError(t('scheduledMessage.attachmentLimit'));
        continue;
      }
      if (kind === 'image') imageCount++;
      else fileCount++;
      next.push({
        id: crypto.randomUUID(),
        kind,
        source: file,
        name: file.name,
        mimeType: file.type,
        lastModified: file.lastModified,
      });
    }
    setAttachments((old) => [...old, ...next]);
  };
  const save = async () => {
    if (
      disabled ||
      !runtime ||
      !user ||
      !document.message ||
      document.definition.destination.kind !== 'existing_session'
    )
      return;
    setSaving(true);
    setError(undefined);
    try {
      await runtime.sendResources.run(async (signal) => {
        const inputBlocks: SessionInputBlock[] =
          text === document.prompt
            ? blocks
            : [
                ...blocks.filter((block) => block.type !== 'text'),
                ...(text.trim() ? [{ type: 'text' as const, text }] : []),
              ];
        const message = await prepareScheduledMessage({
          runtime,
          sessionId:
            document.definition.destination.kind === 'existing_session'
              ? (document.definition.destination.sessionId as SessionId)
              : ('' as SessionId),
          machineId: document.definition.machineId as MachineId,
          actorId: user.id,
          inputBlocks,
          attachments,
          message: document.message,
          signal,
          token,
          localMachineId,
          onAttachments: (next) => {
            setAttachments(next);
            setProgress(
              Math.round(
                next.reduce((sum, item) => sum + (item.progress ?? 0), 0) / Math.max(next.length, 1)
              )
            );
          },
        });
        const {
          scheduleId,
          title,
          machineId,
          agent,
          destination,
          misfirePolicy,
          overlapPolicy,
          retryPolicy,
        } = document.definition;
        await saveScheduledMessage({
          runtime,
          actorId: user.id,
          scheduleId,
          ...identity,
          create: false,
          draft: {
            title,
            machineId,
            agent,
            destination,
            misfirePolicy,
            overlapPolicy,
            retryPolicy,
            prompt: text,
            message,
            trigger: { kind: 'once', at },
          },
        });
      });
      onSaved();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message === 'SCHEDULE_TIME_PASSED'
          ? t('scheduledMessage.futureTime')
          : t('scheduledMessage.saveError')
      );
    } finally {
      setSaving(false);
      setProgress(null);
    }
  };
  const existing = blocks.flatMap((block, index) =>
    block.type !== 'file' && block.type !== 'image'
      ? []
      : [
          {
            id: String(index),
            name: block.fileName ?? t('scheduledMessage.attachment'),
            sizeLabel: formatFileSize(block.sizeBytes),
            status: 'uploaded' as const,
            progress: 100,
          },
        ]
  );
  return (
    <div {...stylex.props(styles.layout)}>
      {!document.definition.enabled && !sent ? (
        <p role="status">
          {t(
            state === 'cancelled' ? 'scheduledMessage.cancelled' : 'scheduledMessage.cancelPending'
          )}
        </p>
      ) : null}
      {state === 'failed' ? <p role="status">{t('scheduledMessage.failed')}</p> : null}
      {sent ? (
        <p role="status" {...stylex.props(styles.notice)}>
          {t('scheduledMessage.sent')}
        </p>
      ) : null}
      {disabledReason ? <p {...stylex.props(styles.notice)}>{disabledReason}</p> : null}
      <input
        {...stylex.props(styles.hidden)}
        type="file"
        multiple
        ref={fileInput}
        onChange={(event) => {
          add(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
      <ChatComposer
        variant="session"
        promptValue={text}
        onPromptChange={setText}
        promptDisabled={disabled}
        autoResize
        fileItems={[
          ...existing,
          ...attachments.map((item) => ({
            id: item.id,
            name: item.name,
            sizeLabel: item.error ?? '',
            status: item.ready ? ('uploaded' as const) : ('draft' as const),
            progress: item.progress ?? 0,
          })),
        ]}
        onFileRemove={
          disabled
            ? undefined
            : (id) => {
                if (attachments.some((item) => item.id === id))
                  setAttachments((old) => old.filter((item) => item.id !== id));
                else setBlocks((old) => old.filter((_, index) => String(index) !== id));
              }
        }
        onAttachmentAddClick={disabled ? undefined : () => fileInput.current?.click()}
        onImageDrop={disabled ? undefined : add}
        primaryAction={null}
      />
      {blocks.map((block, index) =>
        block.type === 'comment_reference' || block.type === 'visual_annotation_reference' ? (
          <div key={index}>
            <label htmlFor={`scheduled-reference-${index}`}>
              {t('scheduledMessage.reference')}
            </label>
            <Textarea
              id={`scheduled-reference-${index}`}
              disabled={disabled}
              value={block.type === 'comment_reference' ? block.commentBody : block.body}
              onChange={(event) => {
                const value = event.target.value;
                setBlocks((old) =>
                  old.map((entry, position) =>
                    position !== index
                      ? entry
                      : entry.type === 'comment_reference'
                        ? { ...entry, commentBody: value }
                        : entry.type === 'visual_annotation_reference'
                          ? { ...entry, body: value }
                          : entry
                  )
                );
              }}
            />
            <Button
              variant="ghost"
              size="small"
              disabled={disabled}
              onClick={() => setBlocks((old) => old.filter((_, position) => position !== index))}
            >
              {t('scheduledMessage.removeReference')}
            </Button>
          </div>
        ) : null
      )}
      <ScheduledMessageTimeFields
        at={at}
        onChange={setAt}
        timeZone={getDeviceTimeZone(machine?.timeZone)}
        disabled={disabled}
      />
      {error ? <p role="alert">{error}</p> : null}
      {progress !== null ? (
        <p role="status">{t('scheduledMessage.preparing', { progress })}</p>
      ) : null}
      {document.definition.enabled && !sent ? (
        <Button
          variant="secondary"
          disabled={saving || user?.id !== document.definition.ownerId}
          onClick={() => {
            setSaving(true);
            setError(undefined);
            void onCancel()
              .catch(() => setError(t('scheduledMessage.saveError')))
              .finally(() => setSaving(false));
          }}
        >
          {t('scheduledMessage.cancel')}
        </Button>
      ) : null}
      <Button
        disabled={
          disabled ||
          !Number.isFinite(Date.parse(at)) ||
          Date.parse(at) <= getServerNow() ||
          (!text.trim() && !blocks.some((block) => block.type !== 'text') && !attachments.length)
        }
        onClick={() => void save()}
      >
        <Clock size={14} />
        {saving ? t('schedules.saving') : t('scheduledMessage.saveChanges')}
      </Button>
    </div>
  );
}

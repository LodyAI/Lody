import { WorkspaceFeatureUnavailableError } from '@/lib/workspace-feature';
import { useEffect, useRef, useState } from 'react';
import { atom, useAtom, useAtomValue, type PrimitiveAtom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import { useTranslation } from 'react-i18next';
import {
  getDeviceTimeZone,
  getServerNow,
  machineSupportsScheduledMessagesProtocol,
  scheduledMessagePrompt,
  type MachineMeta,
  type SessionMeta,
  type SessionInputBlock,
  type ScheduledMessage,
  type ScheduleDefinition,
  type MachineId,
} from '@lody/shared';
import { userAtom } from '@/atoms';
import { activeWorkspaceRuntimeAtom, authTokenAtom } from '@/atoms/runtime';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';
import { useWorkspaceFeatureReason } from '@/hooks/use-workspace-feature';
import type { SessionAttachmentDraft } from '@/lib/session-attachment-draft';
import { toast } from '@/lib/toast';
import {
  SCHEDULED_MESSAGE_POLICY,
  prepareScheduledMessage,
  saveScheduledMessage,
  scheduledAttachmentProgress,
} from './scheduled-message-write';

const PREFIX = 'lody:scheduledMessageDraft:';
type Draft = { at: string; scheduleId: string; activationId: string; activityId: string };
function read(key: string): Draft | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as Partial<Draft>;
    return typeof value.at === 'string' &&
      Number.isFinite(Date.parse(value.at)) &&
      typeof value.scheduleId === 'string' &&
      typeof value.activationId === 'string' &&
      typeof value.activityId === 'string'
      ? (value as Draft)
      : null;
  } catch {
    return null;
  }
}
function persist(key: string, draft: Draft | null) {
  try {
    if (draft) localStorage.setItem(key, JSON.stringify(draft));
    else localStorage.removeItem(key);
  } catch {
    /* The in-memory draft remains editable. */
  }
}

// React can detach and reattach subscriptions within the same commit. Keep the
// atom identity across that handoff and count observers in every Jotai store.
function evictAfterLastObserver(evict: () => void) {
  let observers = 0;
  let generation = 0;
  return () => {
    observers += 1;
    generation += 1;
    return () => {
      observers -= 1;
      const released = ++generation;
      queueMicrotask(() => {
        if (observers === 0 && generation === released) evict();
      });
    };
  };
}

// The persisted draft survives navigation; empty observer caches need not.
const draftAtoms = atomFamily((key: string): PrimitiveAtom<Draft | null> => {
  const value = atom(read(key));
  value.onMount = evictAfterLastObserver(() => draftAtoms.remove(key));
  return value;
});
const savingAtoms = atomFamily((key: string): PrimitiveAtom<boolean> => {
  const value = atom(false);
  value.onMount = evictAfterLastObserver(() => savingAtoms.remove(key));
  return value;
});

export function useScheduledMessageDraft(
  session: SessionMeta,
  machine: MachineMeta | null | undefined
) {
  const { t } = useTranslation();
  const active = useAtomValue(activeWorkspaceRuntimeAtom);
  const scope = useResolvedWorkspaceScope();
  const runtime = scope.enabled && scope.workspaceId === active?.workspaceId ? active : null;
  const user = useAtomValue(userAtom);
  const featureReason = useWorkspaceFeatureReason('schedules');
  const key = `${PREFIX}${runtime?.accountId ?? user?.id}:${runtime?.workspaceId}:${session.id}`;
  const [draft, updateDraft] = useAtom(draftAtoms(key));
  const [saving, setSaving] = useAtom(savingAtoms(key));
  const disabledReason =
    featureReason ??
    (!runtime || !user
      ? t('scheduledMessage.workspaceNotReady')
      : session.userId !== user.id || machine?.ownerUserId !== user.id
        ? t('scheduledMessage.ownMachine')
        : !machineSupportsScheduledMessagesProtocol(machine)
          ? t('scheduledMessage.upgrade')
          : session.isArchived
            ? t('scheduledMessage.archived')
            : undefined);
  const setDraft = (next: Draft | null) => {
    persist(key, next);
    updateDraft(next);
  };
  return {
    key,
    runtime,
    user,
    draft,
    setDraft,
    saving,
    setSaving,
    clearAccepted: (activityId: string) =>
      updateDraft((current) => {
        if (current?.activityId !== activityId) return current;
        persist(key, null);
        return null;
      }),
    available: !featureReason && !!runtime,
    featureUnavailable: !!featureReason,
    disabledReason,
    at: draft?.at ?? null,
    timeZone: getDeviceTimeZone(machine?.timeZone),
    apply: (at: string) =>
      setDraft(
        draft
          ? { ...draft, at }
          : {
              at,
              scheduleId: crypto.randomUUID(),
              activationId: crypto.randomUUID(),
              activityId: crypto.randomUUID(),
            }
      ),
    cancel: () => setDraft(null),
  };
}

export function useScheduledMessage(session: SessionMeta, machine: MachineMeta | null | undefined) {
  const { t } = useTranslation();
  const shared = useScheduledMessageDraft(session, machine);
  const { key, runtime, user, draft, disabledReason } = shared;
  const token = useAtomValue(authTokenAtom);
  const localMachineId = useAtomValue(localMachineIdAtom);
  const [pickerKey, setPickerKey] = useState<string | null>(null);
  const owner = useRef<{ key: string; controller: AbortController } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    owner.current = { key, controller };
    return () => {
      controller.abort();
      if (owner.current?.controller === controller) owner.current = null;
    };
  }, [key, runtime]);
  const [progress, setProgress] = useState<number | null>(null);
  const prepared = useRef<{ key: string; attachments: SessionAttachmentDraft[] } | null>(null);
  return {
    ...shared,
    pickerOpen: pickerKey === key,
    openPicker: () => setPickerKey(key),
    closePicker: () => setPickerKey(null),
    apply: (at: string) => {
      shared.apply(at);
      setPickerKey(null);
    },
    cancel: () => {
      shared.cancel();
      setPickerKey(null);
    },
    progress,
    save: async (args: {
      inputBlocks: SessionInputBlock[];
      attachments: SessionAttachmentDraft[];
      agent: ScheduleDefinition['agent'];
      message: Omit<ScheduledMessage, 'inputBlocks'>;
    }): Promise<boolean> => {
      if (
        !draft ||
        !runtime ||
        !user ||
        disabledReason ||
        !session.machineId ||
        !owner.current ||
        owner.current.key !== key
      ) {
        toast.error(disabledReason ?? t('scheduledMessage.saveError'));
        return false;
      }
      const owned = owner.current;
      shared.setSaving(true);
      try {
        setProgress(args.attachments.length ? 0 : null);
        await runtime.sendResources.run(async (signal) => {
          signal.throwIfAborted();
          if (Date.parse(draft.at) <= getServerNow()) throw new Error('SCHEDULE_TIME_PASSED');
          // Retain successful transfer receipts across failed writes, so retrying does not reupload.
          const receipts = prepared.current?.key === key ? prepared.current.attachments : [];
          const attachments = args.attachments.map((item) => {
            const receipt = receipts.find(
              (prior) =>
                prior.id === item.id &&
                prior.lastModified === item.lastModified &&
                prior.name === item.name
            );
            return receipt?.ready ? { ...item, ready: receipt.ready } : item;
          });
          const message = await prepareScheduledMessage({
            runtime,
            sessionId: session.id,
            machineId: session.machineId as MachineId,
            actorId: user.id,
            ...args,
            attachments,
            token,
            localMachineId,
            signal,
            onAttachments: (next) => {
              prepared.current = { key, attachments: next };
              if (owner.current === owned) setProgress(scheduledAttachmentProgress(next));
            },
          });
          signal.throwIfAborted();
          const prompt = scheduledMessagePrompt(message);
          await saveScheduledMessage({
            runtime,
            actorId: user.id,
            ...draft,
            create: true,
            draft: {
              title: prompt.trim().split('\n')[0]?.slice(0, 200) || t('scheduledMessage.title'),
              prompt,
              message,
              trigger: { kind: 'once', at: draft.at },
              destination: { kind: 'existing_session', sessionId: session.id },
              machineId: session.machineId,
              agent: args.agent,
              ...SCHEDULED_MESSAGE_POLICY,
            },
          });
        }, owned.controller.signal);
        // The write may have completed after navigation; retire only this draft identity.
        shared.clearAccepted(draft.activityId);
        if (owner.current === owned) {
          setPickerKey(null);
          setProgress(null);
        }
        toast.success(t('scheduledMessage.saved'));
        return true;
      } catch (error) {
        if (owner.current === owned) {
          setProgress(null);
          toast.error(
            error instanceof Error && error.message === 'SCHEDULE_TIME_PASSED'
              ? t('scheduledMessage.futureTime')
              : error instanceof WorkspaceFeatureUnavailableError
                ? error.message
                : t('scheduledMessage.saveError')
          );
        }
        return false;
      } finally {
        shared.setSaving(false);
      }
    },
  };
}

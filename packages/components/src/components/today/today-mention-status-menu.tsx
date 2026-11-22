import { AlarmClock, ArrowUpCircle, CheckCircle2, Mail, MailOpen, Timer } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { usePlatform } from '@lody/platform/react';
import { getServerNow, getSessionRoomId, type SessionId } from '@lody/shared';
import { userAtom } from '@/atoms';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { useStatusViewWritable } from '@/hooks/use-status-view-writable';
import { useOrganization } from '@/hooks/useOrganization';
import {
  useVisibleLocalProjectKeySet,
  useVisibleMachineIdSet,
} from '@/hooks/use-visible-session-metas';
import { isSessionEditableToUser } from '@/lib/session-visibility';
import { Menu } from '@lody/ui/menu';
import {
  CustomSnoozeDialog,
  type CustomSnoozeDialogTarget,
} from '@/components/sidebar-status-snooze-dialog';
import { useSessionActions } from '@/hooks/use-session-actions';
import { buildSnoozePresets, type SnoozePresetId } from '@lody/shared';
import { toast } from '@/lib/toast';
import { useTodayEditor } from './editor/today-editor-context';
import { useTodaySessionDisplay } from './today-session-mention';

/** What the status menu writes: the sidebar's own session metadata actions. */
export type TodayMentionStatusActions = {
  markRead(sessionId: SessionId, lastMessageAt: number | null): Promise<void> | void;
  markUnread(sessionId: SessionId): Promise<void> | void;
  snooze(sessionId: SessionId, snoozedUntil: number): Promise<void> | void;
  settle(sessionId: SessionId): Promise<void> | void;
  moveToFocus(sessionId: SessionId): Promise<void> | void;
};

/** The status menu wired to `useSessionActions`, as the sidebar's row menu is. */
export function TodayMentionStatusMenuHost() {
  const actions = useSessionActions();
  const wired = useMemo<TodayMentionStatusActions>(
    () => ({
      markRead: (id, lastMessageAt) => actions.markSessionRead(id, lastMessageAt),
      markUnread: (id) => actions.markSessionUnread(id),
      snooze: (id, until) => actions.snoozeSession(id, until),
      settle: (id) => actions.settleSession(id),
      moveToFocus: (id) => actions.moveSessionToFocus(id),
    }),
    [actions]
  );
  return <TodayMentionStatusMenu actions={wired} />;
}

/**
 * The menu a mention's status icon opens (or Alt+Enter on a selected mention):
 * Mark as read/unread, Later (presets and custom time), Done, and Move to
 * Focus while Later or Done. Behavior: specs/today-outline.md (Conversation
 * mentions).
 */
export function TodayMentionStatusMenu(props: { actions: TodayMentionStatusActions }) {
  const controller = useTodayEditor();
  const [target, setTarget] = useState<{ sessionId: SessionId; anchor: HTMLElement } | null>(null);
  const [custom, setCustom] = useState<CustomSnoozeDialogTarget | null>(null);
  useEffect(() => {
    if (!controller) return undefined;
    controller.onMentionMenu = (sessionId, anchor) =>
      setTarget({ sessionId: sessionId as SessionId, anchor });
    return () => {
      controller.onMentionMenu = null;
    };
  }, [controller]);
  return (
    <>
      {target ? (
        <TodayMentionStatusMenuContent
          key={target.sessionId}
          {...target}
          actions={props.actions}
          onClose={() => setTarget(null)}
          onCustom={(title) => setCustom({ sessionId: target.sessionId, title })}
        />
      ) : null}
      <CustomSnoozeDialog
        target={custom}
        now={new Date(getServerNow())}
        onClose={() => setCustom(null)}
        onConfirm={(sessionId, until) => run(props.actions.snooze(sessionId as SessionId, until))}
      />
    </>
  );
}

function run(result: Promise<void> | void) {
  void Promise.resolve(result).catch((error: unknown) => {
    toast.error(error instanceof Error ? error.message : String(error));
  });
}

function TodayMentionStatusMenuContent(props: {
  sessionId: SessionId;
  anchor: HTMLElement;
  actions: TodayMentionStatusActions;
  onClose: () => void;
  onCustom: (title: string) => void;
}) {
  const { t } = useTranslation();
  const { sessionId, actions } = props;
  const display = useTodaySessionDisplay(sessionId);
  const canManage = useCanManageSessionStatus(sessionId);
  const now = new Date(getServerNow());
  if (display.state !== 'ok') return null;
  const laterLabel = t('sessions.contextMenu.snooze', 'Later');
  const presetLabel: Record<SnoozePresetId, string> = {
    oneHour: t('sessions.contextMenu.snoozeOneHour', 'In 1 hour'),
    laterToday: t('sessions.contextMenu.snoozeLaterToday', 'In 3 hours'),
    tomorrowMorning: t('sessions.contextMenu.snoozeTomorrowMorning', 'Tomorrow morning'),
    nextWeek: t('sessions.contextMenu.snoozeNextWeek', 'Next week'),
  };
  return (
    <Menu.Root
      open
      onOpenChange={(open, details) => {
        // Anchored without a trigger, Base UI reads its own Later submenu
        // opening as a sibling menu opening; that must not close it.
        if (!open && details.reason !== 'sibling-open') props.onClose();
      }}
    >
      <Menu.Content anchor={props.anchor} align="start" finalFocus={false}>
        {display.unread ? (
          <Menu.Item
            icon={MailOpen}
            onClick={() => run(actions.markRead(sessionId, display.lastMessageAt))}
          >
            {t('today.markRead', 'Mark as read')}
          </Menu.Item>
        ) : (
          <Menu.Item icon={Mail} onClick={() => run(actions.markUnread(sessionId))}>
            {t('sessions.contextMenu.markUnread', 'Mark as unread')}
          </Menu.Item>
        )}
        {canManage ? (
          <Menu.Submenu>
            <Menu.SubmenuTrigger icon={AlarmClock}>
              {display.snoozeCountdown
                ? t('today.laterWithCountdown', '{{label}} · {{countdown}}', {
                    label: laterLabel,
                    countdown: display.snoozeCountdown,
                  })
                : laterLabel}
            </Menu.SubmenuTrigger>
            <Menu.Content>
              {buildSnoozePresets(now).map((preset) => (
                <Menu.Item
                  key={preset.id}
                  shortcut={preset.countdown}
                  onClick={() => run(actions.snooze(sessionId, preset.timestamp))}
                >
                  {presetLabel[preset.id]}
                </Menu.Item>
              ))}
              <Menu.Separator />
              <Menu.Item icon={Timer} onClick={() => props.onCustom(display.title)}>
                {t('sessions.contextMenu.snoozeCustom', 'Custom time…')}
              </Menu.Item>
            </Menu.Content>
          </Menu.Submenu>
        ) : null}
        {canManage && display.group !== 'settled' ? (
          <Menu.Item icon={CheckCircle2} onClick={() => run(actions.settle(sessionId))}>
            {t('today.markDone', 'Done')}
          </Menu.Item>
        ) : null}
        {canManage && display.group !== 'focus' ? (
          <Menu.Item icon={ArrowUpCircle} onClick={() => run(actions.moveToFocus(sessionId))}>
            {t('sessions.contextMenu.moveToFocus', 'Move to Focus')}
          </Menu.Item>
        ) : null}
      </Menu.Content>
    </Menu.Root>
  );
}

/**
 * Status actions write shared session metadata, so they are offered only where
 * the management guard would accept them: a writable member, a conversation
 * that is not archived, on a machine and project this member can edit.
 */
function useCanManageSessionStatus(sessionId: SessionId): boolean {
  const platform = usePlatform();
  const writable = useStatusViewWritable(useOrganization().role);
  const meta = useAtomValue(sessionMetaAtomFamily(getSessionRoomId(sessionId)));
  const userId = useAtomValue(userAtom)?.id ?? null;
  const { visibleMachineIds, ownedMachineIds } = useVisibleMachineIdSet();
  const { visibleLocalProjectKeys } = useVisibleLocalProjectKeySet();
  if (!writable || !meta || meta.isArchived === true) return false;
  if (platform.kind === 'local') return true;
  return isSessionEditableToUser(
    meta,
    visibleMachineIds,
    visibleLocalProjectKeys,
    userId,
    ownedMachineIds
  );
}

import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ExternalLink, MessageSquare } from 'lucide-react';
import type { ScheduleDestination } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Combobox } from '@lody/ui/combobox';
import { Select } from '@lody/ui/select';
import { PropertyRow } from './schedule-property-row';
import { FieldIssueMark } from './schedule-field-issue-mark';

export type PickableSession = {
  id: string;
  title: string;
  /** Secondary line: "Code reviewer · MacBook Pro". */
  detail?: string;
};

const DESTINATION_KINDS = ['new_session', 'own_session', 'existing_session'] as const;

/**
 * Where each run's prompt goes.
 *
 * Three answers, in the order people reach for them: a fresh chat every time,
 * one chat this task keeps appending to, or a chat they already have. The
 * follow-up row appears only for the two that name a chat, and the owned chat
 * is described honestly — "created on the first run" until it exists, then a
 * link to it plus the one action that changes it.
 */
export function ScheduleDestinationRows({
  value,
  onChange,
  sessions,
  ownSession,
  pickedSession,
  onOpenSession,
  issues = [],
  disabled,
}: {
  value: ScheduleDestination;
  onChange: (next: ScheduleDestination) => void;
  /** Chats the person may send into (their own, on any machine). */
  sessions: readonly PickableSession[];
  /** The chat this schedule owns, once the first run has created it. */
  ownSession?: PickableSession | null;
  /** The chosen existing chat, when it is known. */
  pickedSession?: PickableSession | null;
  onOpenSession?: (id: string) => void;
  /** Save problems this choice causes; marked on the row that fixes them. */
  issues?: readonly string[];
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const reduce = useReducedMotion();
  // A picked chat is where a mismatch is fixed; otherwise the Send to row.
  const chatIssues = value.kind === 'existing_session' ? issues : [];
  const sendToIssues = value.kind === 'existing_session' ? [] : issues;
  const labels: Record<ScheduleDestination['kind'], string> = {
    new_session: t('schedules.destination.newSession', 'New chat each run'),
    own_session: t('schedules.destination.ownSession', 'One chat for this task'),
    existing_session: t('schedules.destination.existingSession', 'An existing chat'),
  };
  return (
    <>
      <PropertyRow label={t('schedules.sendTo', 'Send to')}>
        <FieldIssueMark messages={sendToIssues} className="mr-1" />
        <Select.Root
          value={value.kind}
          disabled={disabled}
          items={DESTINATION_KINDS.map((kind) => ({ value: kind, label: labels[kind] }))}
          onValueChange={(kind) => {
            if (
              typeof kind !== 'string' ||
              kind === value.kind ||
              !(DESTINATION_KINDS as readonly string[]).includes(kind)
            )
              return;
            onChange(
              kind === 'own_session'
                ? { kind, epoch: 0 }
                : kind === 'existing_session'
                  ? { kind, sessionId: '' }
                  : { kind: 'new_session' }
            );
          }}
        >
          <Select.Trigger size="small" aria-label={t('schedules.sendTo', 'Send to')}>
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            {DESTINATION_KINDS.map((kind) => (
              <Select.Item key={kind} value={kind}>
                {labels[kind]}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </PropertyRow>

      <AnimatePresence initial={false} mode="popLayout">
        {value.kind === 'own_session' ? (
          <motion.div
            key="own"
            layout
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <PropertyRow
              label={t('schedules.destination.chat', 'Chat')}
              hint={
                ownSession
                  ? t(
                      'schedules.destination.ownSessionLockedHint',
                      'The Agent is now this chat’s Agent. Start a new chat to change it.'
                    )
                  : t(
                      'schedules.destination.ownSessionPendingHint',
                      'Created on the first run; every later run continues it.'
                    )
              }
            >
              {ownSession ? (
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    className="max-w-56"
                    onClick={() => onOpenSession?.(ownSession.id)}
                  >
                    <MessageSquare className="size-3.5 shrink-0" />
                    <span className="truncate">{ownSession.title}</span>
                    <ExternalLink className="size-3 shrink-0" />
                  </Button>
                  <Button
                    type="button"
                    variant="link"
                    size="small"
                    disabled={disabled}
                    onClick={() => onChange({ kind: 'own_session', epoch: value.epoch + 1 })}
                  >
                    {t('schedules.destination.startNewChat', 'Start a new chat')}
                  </Button>
                </div>
              ) : (
                <span className="text-[0.9em] text-muted-foreground">
                  {t('schedules.destination.notCreatedYet', 'Not created yet')}
                </span>
              )}
            </PropertyRow>
          </motion.div>
        ) : null}

        {value.kind === 'existing_session' ? (
          <motion.div
            key="existing"
            layout
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <PropertyRow
              label={t('schedules.destination.chat', 'Chat')}
              hint={
                pickedSession
                  ? t(
                      'schedules.destination.existingSessionHint',
                      'Runs use this chat’s Agent and workspace.'
                    )
                  : undefined
              }
            >
              <FieldIssueMark messages={chatIssues} className="mr-1" />
              <SessionPicker
                sessions={sessions}
                value={value.sessionId}
                label={pickedSession?.title}
                disabled={disabled}
                onChange={(sessionId) => onChange({ kind: 'existing_session', sessionId })}
              />
            </PropertyRow>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

function SessionPicker({
  sessions,
  value,
  onChange,
  disabled,
}: {
  sessions: readonly PickableSession[];
  value: string;
  label?: string;
  onChange: (sessionId: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const picked = sessions.find((session) => session.id === value) ?? null;
  // Picking one chat from a list you can filter as you type is the Combobox.
  return (
    <Combobox.Root
      items={[...sessions]}
      value={picked}
      disabled={disabled}
      itemToStringLabel={(session: PickableSession) => session.title}
      isItemEqualToValue={(left: PickableSession, right: PickableSession) => left.id === right.id}
      onValueChange={(session: PickableSession | null) => {
        if (session) onChange(session.id);
      }}
    >
      <Combobox.Button
        size="small"
        aria-label={t('schedules.destination.chooseChat', 'Choose a chat')}
        placeholder={t('schedules.destination.chooseChat', 'Choose a chat')}
        className="max-w-64"
      />
      <Combobox.Content
        search={
          <Combobox.Search
            aria-label={t('schedules.destination.searchChats', 'Search chats')}
            placeholder={t('schedules.destination.searchChats', 'Search chats')}
          />
        }
        empty={
          <Combobox.Empty>{t('schedules.destination.noChats', 'No chats found')}</Combobox.Empty>
        }
      >
        {(session: PickableSession) => (
          <Combobox.Item key={session.id} value={session}>
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{session.title}</span>
              {session.detail ? (
                <span className="truncate text-[0.85em] text-muted-foreground">
                  {session.detail}
                </span>
              ) : null}
            </span>
          </Combobox.Item>
        )}
      </Combobox.Content>
    </Combobox.Root>
  );
}

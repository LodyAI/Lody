import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { Button } from '@/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/ui/card';
import { ScrollArea } from '@/ui/scroll-area';
import { cn } from '@/lib/utils';
import {
  CONVERSATION_PANEL_FRAME_CLASS,
  CONVERSATION_PANEL_HEADER_CLASS,
  CONVERSATION_PANEL_HEADER_RULE_CLASS,
} from '@/components/ai-gui/conversation-panel';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import { usePermissionResponse } from '@/hooks/use-permission-response';
import { useKeyboardAwareScrollIntoView } from '@/hooks/use-keyboard-aware-scroll-into-view';
import { useTranslation } from 'react-i18next';
import {
  createAskUserQuestionPermissionOutcome,
  isAskUserQuestionPermissionMeta,
  parseAskUserQuestionPermissionMeta,
  type AskUserQuestionAnswers,
  type MessageContent,
  type SessionDoc,
  type SessionHistory,
  type SessionId,
  type SessionStatus,
} from '@lody/shared';
import { AskUserQuestionCard } from './ask-user-question-card';

type ToolCallContent = Extract<MessageContent, { type: 'tool_call' }>;
export type PermissionOption = NonNullable<ToolCallContent['permissionRequest']>['options'][number];

interface PendingPermission {
  /** The turn the request lives on, so responding addresses it directly. */
  turnId: string;
  toolCall: ToolCallContent;
  permission: NonNullable<ToolCallContent['permissionRequest']>;
  isAskUserQuestion: boolean;
}

function findPendingPermissions(history: SessionDoc['history'] | undefined): PendingPermission[] {
  if (!history?.length) return [];

  const results: PendingPermission[] = [];
  for (let i = 0; i < history.length; i++) {
    const entry = history[i] as SessionHistory | undefined;
    if (!entry) continue;
    const items = (entry.items ?? []) as unknown as MessageContent[];
    for (let j = 0; j < items.length; j++) {
      const item = items[j];
      if (
        item &&
        item.type === 'tool_call' &&
        (item as ToolCallContent).permissionRequest &&
        !(item as ToolCallContent).permissionRequest?.outcome
      ) {
        const tc = item as ToolCallContent;
        const permission = tc.permissionRequest!;
        results.push({
          turnId: entry.id,
          toolCall: tc,
          permission,
          isAskUserQuestion: isAskUserQuestionPermissionMeta(permission._meta),
        });
      }
    }
  }
  return results;
}

export function hasPendingAskUserQuestion(
  sessionStatus: SessionStatus | undefined,
  sessionHistory: SessionDoc['history'] | undefined
): boolean {
  if (sessionStatus?.type !== 'requestPermission' && sessionStatus?.type !== 'running')
    return false;
  const pending = findPendingPermissions(sessionHistory);
  return pending.some((entry) => entry.isAskUserQuestion);
}

export function hasPendingPermissionRequest(
  sessionStatus: SessionStatus | undefined,
  sessionHistory: SessionDoc['history'] | undefined
): boolean {
  if (sessionStatus?.type !== 'requestPermission' && sessionStatus?.type !== 'running')
    return false;
  return findPendingPermissions(sessionHistory).length > 0;
}

export interface FloatingPermissionRequestProps {
  sessionId: SessionId;
  sessionStatus: SessionStatus | undefined;
  sessionHistory: SessionDoc['history'] | undefined;
}

export interface PermissionRequestCardProps {
  title?: string | null;
  options: PermissionOption[];
  isResolved?: boolean;
  isCancelled?: boolean;
  isReady?: boolean;
  pendingOptionId?: string | null;
  selectedOptionId?: string | null;
  onSelect: (optionId: string) => void;
  className?: string;
}

function CollapsibleCommand({ title }: { title: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const clampedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (expanded) return undefined;
    const element = clampedRef.current;
    if (!element) return undefined;
    const check = () => {
      setIsOverflowing(element.scrollHeight > element.clientHeight + 1);
    };
    check();
    return observeResizeOnAnimationFrame(element, () => check());
  }, [title, expanded]);

  const textClassName = 'whitespace-pre-wrap break-words text-xs leading-5 text-foreground/75';

  return (
    <div className="flex flex-col gap-1">
      <div
        ref={expanded ? undefined : clampedRef}
        className={cn(
          textClassName,
          expanded ? 'max-h-40 overflow-y-auto overscroll-contain pr-2' : 'line-clamp-2'
        )}
      >
        {title}
      </div>
      {(isOverflowing || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-1 rounded-sm text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        >
          <ChevronDown
            className={cn('h-3 w-3 transition-transform duration-200', expanded && 'rotate-180')}
          />
          {expanded
            ? t('sessions.permissionShowLess', 'Show less')
            : t('sessions.permissionShowMore', 'Show more')}
        </button>
      )}
    </div>
  );
}

const getPermissionOptionIdByKind = (
  options: PermissionOption[],
  predicate: (option: PermissionOption) => boolean
): string | null => options.find(predicate)?.optionId ?? null;

const getAskQuestionAnswerOptionId = (options: PermissionOption[]): string | null =>
  getPermissionOptionIdByKind(options, (option) => option.optionId === 'answer') ??
  getPermissionOptionIdByKind(options, (option) => option.kind?.startsWith('allow') === true) ??
  options[0]?.optionId ??
  null;

const getAskQuestionCancelOptionId = (
  options: PermissionOption[],
  answerOptionId: string | null
): string | null =>
  getPermissionOptionIdByKind(
    options,
    (option) =>
      option.optionId !== answerOptionId &&
      (option.kind?.startsWith('deny') === true || option.kind?.startsWith('reject') === true)
  ) ??
  options.find((option) => option.optionId !== answerOptionId)?.optionId ??
  null;

export function PermissionRequestCard({
  title,
  options,
  isResolved = false,
  isCancelled = false,
  isReady = true,
  pendingOptionId = null,
  selectedOptionId = null,
  onSelect,
  className,
}: PermissionRequestCardProps) {
  const { t } = useTranslation();
  const disabled = isResolved || isCancelled || pendingOptionId !== null || !isReady;
  const selectedOption =
    selectedOptionId == null
      ? null
      : options.find((option) => option.optionId === selectedOptionId);
  const selectedOptionIsAllow = selectedOption
    ? selectedOption.kind?.startsWith('allow') === true
    : true;
  const headerLabel = isCancelled
    ? t('sessions.permissionCancelled', 'Permission Cancelled')
    : isResolved
      ? selectedOptionIsAllow
        ? t('sessions.permissionApproved', 'Permission Approved')
        : t('sessions.permissionDenied', 'Permission Denied')
      : t('sessions.permissionRequired', 'Permission Required');
  const showFooter = !isReady;
  const primaryOptionId = options[0]?.optionId ?? null;

  return (
    <Card
      className={cn(
        /* Same panel as the command block, tool output, and the proposed plan:
           the header carries the lighter fill, the body sits on the frame. */
        CONVERSATION_PANEL_FRAME_CLASS,
        'text-xs animate-in fade-in slide-in-from-bottom-2 duration-300',
        className
      )}
    >
      <CardHeader
        className={cn(
          CONVERSATION_PANEL_HEADER_CLASS,
          CONVERSATION_PANEL_HEADER_RULE_CLASS,
          'flex-col items-stretch gap-0.5 py-2'
        )}
      >
        <CardTitle className="text-[13px] font-medium text-muted-foreground">
          {headerLabel}
        </CardTitle>
        {title && <CollapsibleCommand title={title} />}
      </CardHeader>
      <CardContent className={cn('px-3 pt-2', showFooter ? 'pb-1.5' : 'pb-2.5')}>
        <div className="flex flex-col gap-0.5">
          {options.map((option) => {
            const isPending = pendingOptionId === option.optionId && !isResolved;
            const isSelected = selectedOptionId === option.optionId;
            const emphasize = !isResolved && !isCancelled && option.optionId === primaryOptionId;

            let toneClass = 'text-foreground/85 hover:bg-hover hover:text-foreground';
            if (emphasize) {
              toneClass = 'bg-hover text-foreground';
            }
            if (isResolved && isSelected) {
              toneClass = 'bg-hover font-medium text-foreground disabled:opacity-100';
            } else if (isResolved || isCancelled) {
              toneClass = 'text-foreground/45 disabled:opacity-100';
            }

            return (
              <Button
                key={option.optionId}
                size="sm"
                type="button"
                disabled={disabled}
                variant="ghost"
                className={cn(
                  'h-auto min-h-8 w-full min-w-0 items-start justify-start gap-2 whitespace-normal break-words rounded-md px-3 py-1.5 text-left text-xs leading-5 transition-colors',
                  toneClass
                )}
                onClick={() => onSelect(option.optionId)}
              >
                <span
                  className={cn(
                    'mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full transition-colors',
                    emphasize || (isResolved && isSelected)
                      ? 'bg-primary'
                      : 'bg-muted-foreground/50'
                  )}
                />
                <span className="min-w-0 flex-1 whitespace-normal break-words">{option.name}</span>
                {isPending && (
                  <Loader2 className="mt-0.5 ml-auto h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                )}
              </Button>
            );
          })}
        </div>
      </CardContent>
      {showFooter && (
        <CardFooter className="px-3 pb-2.5 pt-1">
          <div className="text-xs text-muted-foreground">
            {t(
              'sessions.permissionActionsDisabled',
              'Permission actions are disabled in this environment.'
            )}
          </div>
        </CardFooter>
      )}
    </Card>
  );
}

function PermissionCard({
  sessionId,
  pending,
  isReady,
}: {
  sessionId: SessionId;
  pending: PendingPermission;
  isReady: boolean;
}) {
  const { respondToPermission } = usePermissionResponse();
  const [pendingOptionId, setPendingOptionId] = useState<string | null>(null);

  const permission = pending.permission;
  const isResolved = Boolean(permission.outcome);
  const askQuestionMeta = useMemo(
    () => parseAskUserQuestionPermissionMeta(permission._meta),
    [permission._meta]
  );
  const { answerOptionId, cancelOptionId } = useMemo(() => {
    const answer = getAskQuestionAnswerOptionId(permission.options);
    return {
      answerOptionId: answer,
      cancelOptionId: getAskQuestionCancelOptionId(permission.options, answer),
    };
  }, [permission.options]);

  const handleSelect = useCallback(
    async (optionId: string) => {
      if (isResolved || !isReady || pendingOptionId !== null) return;
      setPendingOptionId(optionId);
      try {
        await respondToPermission(
          sessionId,
          permission.requestId,
          { outcome: 'selected', optionId },
          { turnId: pending.turnId }
        );
      } catch (error) {
        console.error('Failed to respond to permission request:', error);
        setPendingOptionId(null);
      }
    },
    [
      isResolved,
      isReady,
      pendingOptionId,
      respondToPermission,
      sessionId,
      permission.requestId,
      pending.turnId,
    ]
  );

  const handleSubmitAnswers = useCallback(
    async (answers: AskUserQuestionAnswers) => {
      if (isResolved || !isReady || pendingOptionId !== null) return;
      if (!answerOptionId) return;
      setPendingOptionId(answerOptionId);
      try {
        await respondToPermission(
          sessionId,
          permission.requestId,
          createAskUserQuestionPermissionOutcome(
            answerOptionId,
            answers,
            askQuestionMeta ?? 'claude'
          ),
          { turnId: pending.turnId }
        );
      } catch (error) {
        console.error('Failed to respond to question request:', error);
        setPendingOptionId(null);
      }
    },
    [
      isResolved,
      isReady,
      pendingOptionId,
      pending.turnId,
      askQuestionMeta,
      answerOptionId,
      permission.requestId,
      respondToPermission,
      sessionId,
    ]
  );

  const handleCancelQuestion = useCallback(async () => {
    if (isResolved || !isReady || pendingOptionId !== null) return;
    if (!cancelOptionId) return;
    setPendingOptionId(cancelOptionId);
    try {
      await respondToPermission(
        sessionId,
        permission.requestId,
        { outcome: 'selected', optionId: cancelOptionId },
        { turnId: pending.turnId }
      );
    } catch (error) {
      console.error('Failed to cancel question request:', error);
      setPendingOptionId(null);
    }
  }, [
    isResolved,
    isReady,
    pendingOptionId,
    pending.turnId,
    cancelOptionId,
    permission.requestId,
    respondToPermission,
    sessionId,
  ]);

  if (askQuestionMeta) {
    return (
      <AskUserQuestionCard
        meta={askQuestionMeta}
        mode={{
          kind: 'interactive',
          isReady,
          disabled: isResolved,
          isPendingSubmit: pendingOptionId !== null && pendingOptionId === answerOptionId,
          isPendingCancel: pendingOptionId !== null && pendingOptionId === cancelOptionId,
          onSubmit: (answers) => {
            void handleSubmitAnswers(answers);
          },
          onCancel: () => {
            void handleCancelQuestion();
          },
        }}
      />
    );
  }

  return (
    <PermissionRequestCard
      title={pending.toolCall.title}
      options={permission.options}
      isResolved={isResolved}
      isCancelled={permission.outcome?.outcome === 'cancelled'}
      isReady={isReady}
      pendingOptionId={pendingOptionId}
      selectedOptionId={
        permission.outcome?.outcome === 'selected' ? permission.outcome.optionId : null
      }
      onSelect={(optionId) => {
        void handleSelect(optionId);
      }}
    />
  );
}

export function FloatingPermissionRequest({
  sessionId,
  sessionStatus,
  sessionHistory,
}: FloatingPermissionRequestProps) {
  const { isReady } = usePermissionResponse();
  const askQuestionScrollRef = useRef<HTMLDivElement>(null);

  const pendingList = useMemo(() => {
    if (sessionStatus?.type !== 'requestPermission' && sessionStatus?.type !== 'running') return [];
    return findPendingPermissions(sessionHistory);
  }, [sessionStatus, sessionHistory]);

  useKeyboardAwareScrollIntoView(askQuestionScrollRef);

  if (pendingList.length === 0) return null;

  // When any pending entry is an ask-user-question, the chat input + queue are
  // hidden upstream so the user focuses on answering. This bottom surface must
  // replace the composer keyboard behavior: lift on iOS, resize naturally on
  // Android, and keep focused custom-answer fields visible inside the cap.
  const hasAskUserQuestion = pendingList.some((entry) => entry.isAskUserQuestion);

  const items = (
    <ConversationColumn className="flex flex-col gap-3">
      {pendingList.map((pending) => (
        <PermissionCard
          key={pending.permission.requestId}
          sessionId={sessionId}
          pending={pending}
          isReady={isReady}
        />
      ))}
    </ConversationColumn>
  );

  if (hasAskUserQuestion) {
    return (
      <ScrollArea
        className={cn(
          'mx-3 mb-[calc(0.5rem+var(--native-keyboard-height,0px))]',
          'max-h-[calc(100dvh-var(--native-keyboard-height,0px)-4rem)]',
          'transition-[margin-bottom] duration-[250ms] ease-out'
        )}
        viewportClassName={cn(
          'overscroll-contain',
          'pb-[max(0px,var(--safe-area-bottom,0px)-var(--native-keyboard-height,0px))]'
        )}
        viewportRef={askQuestionScrollRef}
      >
        {items}
      </ScrollArea>
    );
  }

  return (
    <ScrollArea
      className="mx-3 mb-2 max-h-[min(24rem,calc(100vh-14rem))]"
      viewportClassName="overscroll-contain"
    >
      {items}
    </ScrollArea>
  );
}

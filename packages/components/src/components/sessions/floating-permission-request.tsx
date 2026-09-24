import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import * as stylex from '@stylexjs/stylex';
import { ChevronLeft, ChevronRight, CircleStop } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Kbd } from '@lody/ui/kbd';
import { Spinner } from '@lody/ui/spinner';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space } from '@lody/ui/tokens/scales.stylex';
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
import { ScrollArea } from '@/ui/scroll-area';
import { cn } from '@/lib/utils';
import { withClassName } from '@/lib/stylex';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { usePermissionResponse } from '@/hooks/use-permission-response';
import { useKeyboardAwareScrollIntoView } from '@/hooks/use-keyboard-aware-scroll-into-view';
import {
  resolveDismissOptionId,
  resolvePermissionHeading,
  resolvePermissionOptionDescription,
  resolvePermissionOptionTone,
  resolvePermissionQuestionKind,
  resolvePermissionReason,
  resolvePermissionSubject,
  resolveSuggestedOptionId,
  type PermissionOption,
  type PermissionQuestionKind,
  type PermissionRequest,
} from '@/lib/permission-request-presentation';
import { AskUserQuestionCard } from './ask-user-question-card';

export type { PermissionOption };

type ToolCallContent = Extract<MessageContent, { type: 'tool_call' }>;

interface PendingPermission {
  /** The turn the request lives on, so responding addresses it directly. */
  turnId: string;
  toolCall: ToolCallContent;
  permission: PermissionRequest;
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

// =============================================================================
// Styles
// =============================================================================

/** A block inside the prompt that shows a value rather than holding one. */
const REGION = `color-mix(in oklab, transparent, ${colors.label} 5%)`;
const MONO = 'var(--font-mono, ui-monospace, monospace)';
const RING = `0 0 0 2px ${colors.accent}`;
/** Only a device with a keyboard and a pointer that hovers gets the key cap. */
const HAS_KEYBOARD = '@media (hover: hover) and (pointer: fine)';
/**
 * Every block's text starts on one edge: the card's padding plus this inset,
 * which is also where a row's fill begins, so a filled row and the heading
 * above it share a left edge.
 */
const INSET = space[3];

const styles = stylex.create({
  /**
   * The prompt takes the composer's place, so it is the composer's rung: a
   * card lifted off the conversation. One surface, three blocks — the
   * question, what would happen, the answers — and nothing else.
   */
  card: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    paddingInline: space[1.5],
    paddingTop: space[3],
    paddingBottom: space[1.5],
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
    borderRadius: radius.large,
    cornerShape: corner.shape,
    color: colors.label,
    outlineStyle: 'none',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[2],
    minWidth: 0,
    paddingInline: INSET,
  },
  headerText: { flexGrow: 1, minWidth: 0 },
  heading: { margin: 0, fontSize: '0.95em', fontWeight: 500, lineHeight: '24px' },
  /** Why the agent is asking, or what it named the call when it sent no code. */
  detail: {
    margin: 0,
    fontSize: '0.85em',
    lineHeight: 1.4,
    color: colors.secondaryLabel,
    overflowWrap: 'anywhere',
  },
  headerEnd: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: '2px',
    marginInlineEnd: `calc(-1 * ${space[1.5]})`,
    fontSize: '0.8em',
    color: colors.tertiaryLabel,
    fontVariantNumeric: 'tabular-nums',
  },
  positionLabel: { paddingInline: '2px' },

  /** Exactly what would run or be touched, as code: the one boxed thing. */
  subject: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'baseline',
    gap: space[3],
    marginInline: space[1.5],
    maxHeight: '9.5em',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    paddingInline: `calc(${INSET} - ${space[1.5]})`,
    paddingBlock: space[2],
    backgroundColor: REGION,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    fontFamily: MONO,
    fontSize: '0.85em',
    lineHeight: 1.5,
  },
  subjectBody: {
    flexGrow: 1,
    minWidth: 0,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  subjectLine: { display: 'block' },
  /** Where it runs: the directory, trailing the command, quieter. */
  subjectWhere: {
    flexShrink: 0,
    maxWidth: '40%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.tertiaryLabel,
  },

  /** The answers: the provider's own sentences, one row each, no marks. */
  options: { display: 'flex', flexDirection: 'column', gap: '1px' },
  option: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[3],
    width: '100%',
    minHeight: { default: '32px', '@media (pointer: coarse)': '44px' },
    margin: 0,
    paddingInline: INSET,
    paddingBlock: '6px',
    borderWidth: 0,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: {
      default: 'transparent',
      ':hover': colors.hoverFill,
      ':focus-visible': colors.hoverFill,
    },
    boxShadow: { default: 'none', ':focus-visible': `inset ${RING}` },
    outlineStyle: 'none',
    color: colors.label,
    fontFamily: 'inherit',
    fontSize: '0.9em',
    lineHeight: '20px',
    textAlign: 'start',
    cursor: { default: 'pointer', ':disabled': 'default' },
    opacity: { default: 1, ':disabled': 0.45 },
  },
  /** The answer the request suggests: already lit, so it reads as the default. */
  optionSuggested: {
    backgroundColor: {
      default: colors.selectedFill,
      ':hover': colors.hoverFill,
      ':focus-visible': colors.hoverFill,
    },
  },
  /** The one being sent: full strength while the rest wait. */
  optionSending: { opacity: { default: 1, ':disabled': 1 } },
  optionText: { flexGrow: 1, minWidth: 0, overflowWrap: 'anywhere' },
  optionDescription: {
    display: 'block',
    fontSize: '0.9em',
    lineHeight: 1.4,
    color: colors.secondaryLabel,
  },
  optionTrail: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    height: '20px',
    color: colors.tertiaryLabel,
  },
  keyHint: { display: { default: 'none', [HAS_KEYBOARD]: 'inline-flex' } },

  status: {
    margin: 0,
    paddingInline: INSET,
    paddingBlock: space[1],
    fontSize: '0.85em',
    lineHeight: 1.4,
    color: colors.secondaryLabel,
  },
  statusError: { color: colors.destructive },

  queueStrip: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '2px',
    marginBottom: space[1],
    fontSize: '0.8em',
    color: colors.tertiaryLabel,
    fontVariantNumeric: 'tabular-nums',
  },
});

// =============================================================================
// The prompt
// =============================================================================

export interface PermissionPromptPosition {
  /** Zero-based. */
  index: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
}

export interface PermissionPromptProps {
  toolCall: ToolCallContent;
  permission: PermissionRequest;
  onSelect: (optionId: string) => void;
  /** The option whose answer is on its way; every option waits for it. */
  sendingOptionId?: string | null;
  /** Why the last answer did not arrive. */
  error?: string | null;
  /** False while this client cannot answer yet (the workspace is connecting). */
  isReady?: boolean;
  /** Where this request sits among the pending ones, when there is more than one. */
  position?: PermissionPromptPosition;
  /** Stop the agent instead of answering. */
  onStop?: () => void;
  /** Take keyboard focus on arrival when nothing else holds it. */
  autoFocus?: boolean;
  className?: string;
}

/**
 * One permission request, asked the way a person reads it: the question, then
 * exactly what would run or be touched, then the provider's own answers —
 * never rewritten, since "Yes, and don't ask again for `git` commands" says
 * more than any label Lody could put on it. The answers carry no marks: every
 * provider's answer already begins with what it is ("Yes", "No", "Allow").
 *
 * Keyboard: the arrows walk the answers starting from the suggested one, Enter
 * or Space answers the one you are on, and Escape refuses once. Enter on the
 * prompt itself does nothing: a person who was typing a message when the
 * request replaced the composer must not approve it with the Enter meant for
 * their message, so an answer always takes a deliberate first step.
 */
export function PermissionPrompt({
  toolCall,
  permission,
  onSelect,
  sendingOptionId = null,
  error = null,
  isReady = true,
  position,
  onStop,
  autoFocus = false,
  className,
}: PermissionPromptProps) {
  const { t } = useTranslation();
  const cardRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const options = permission.options;
  const questionKind = resolvePermissionQuestionKind(toolCall.kind);
  const heading = resolvePermissionHeading(permission) ?? t(QUESTION_KEYS[questionKind]);
  const reason = resolvePermissionReason(permission);
  const subject = resolvePermissionSubject(toolCall);
  // Prose the agent titled the call with is a detail under the question, not
  // code in a box; and it is dropped when it only restates the question.
  const subjectText =
    subject?.type === 'text' && !restates(subject.text, heading) ? subject.text : null;
  const suggestedOptionId = resolveSuggestedOptionId(permission);
  const dismissOptionId = resolveDismissOptionId(options);
  const disabled = !isReady || sendingOptionId !== null;

  useEffect(() => {
    if (!autoFocus) return;
    const active = document.activeElement;
    // Never take focus from something a person is using: only from nothing,
    // which is where it lands when the composer this prompt replaced unmounts.
    if (active && active !== document.body) return;
    cardRef.current?.focus({ preventScroll: true });
  }, [autoFocus, permission.requestId]);

  const focusOption = (optionId: string | null | undefined) => {
    if (!optionId) return;
    optionRefs.current.get(optionId)?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      if (dismissOptionId && !disabled) {
        event.preventDefault();
        onSelect(dismissOptionId);
      }
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const currentIndex = options.findIndex(
      (option) => optionRefs.current.get(option.optionId) === document.activeElement
    );
    if (currentIndex === -1) {
      // The first step lands on the suggestion, whichever arrow it was.
      focusOption(suggestedOptionId);
      return;
    }
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = options[(currentIndex + step + options.length) % options.length];
    focusOption(next?.optionId);
  };

  return (
    <div
      ref={cardRef}
      role="group"
      tabIndex={-1}
      aria-label={heading}
      onKeyDown={handleKeyDown}
      {...withClassName(stylex.props(styles.card), className)}
    >
      <div {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.headerText)}>
          <p {...stylex.props(styles.heading)}>{heading}</p>
          {reason ? <p {...stylex.props(styles.detail)}>{reason}</p> : null}
          {subjectText ? <p {...stylex.props(styles.detail)}>{subjectText}</p> : null}
        </div>
        {(position && position.total > 1) || onStop ? (
          <div {...stylex.props(styles.headerEnd)}>
            {position && position.total > 1 ? <PositionControl position={position} /> : null}
            {onStop ? (
              <Button
                variant="ghost"
                size="small"
                icon
                aria-label={t('sessions.permission.stop', 'Stop the agent')}
                title={t('sessions.permission.stop', 'Stop the agent')}
                onClick={onStop}
              >
                <CircleStop aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {subject && subject.type !== 'text' ? (
        <div
          {...stylex.props(styles.subject)}
          aria-label={t('sessions.permission.subject', 'What the agent wants to do')}
        >
          <span {...stylex.props(styles.subjectBody)}>
            {subject.type === 'command'
              ? subject.command
              : subject.paths.map((path) => (
                  <span key={path} {...stylex.props(styles.subjectLine)}>
                    {path}
                  </span>
                ))}
          </span>
          {subject.type === 'command' && subject.cwd ? (
            <span {...stylex.props(styles.subjectWhere)} title={subject.cwd}>
              {t('sessions.permission.inDirectory', 'in {{path}}', { path: subject.cwd })}
            </span>
          ) : null}
        </div>
      ) : null}

      <div {...stylex.props(styles.options)}>
        {options.map((option) => {
          const description = resolvePermissionOptionDescription(option);
          const suggested = option.optionId === suggestedOptionId;
          const sending = option.optionId === sendingOptionId;
          const isDismiss = option.optionId === dismissOptionId;
          return (
            <button
              key={option.optionId}
              ref={(node) => {
                if (node) optionRefs.current.set(option.optionId, node);
                else optionRefs.current.delete(option.optionId);
              }}
              type="button"
              disabled={disabled}
              aria-keyshortcuts={isDismiss ? 'Escape' : undefined}
              data-tone={resolvePermissionOptionTone(option)}
              onClick={() => onSelect(option.optionId)}
              {...stylex.props(
                styles.option,
                suggested && styles.optionSuggested,
                sending && styles.optionSending
              )}
            >
              <span {...stylex.props(styles.optionText)}>
                {option.name}
                {description ? (
                  <span {...stylex.props(styles.optionDescription)}>{description}</span>
                ) : null}
              </span>
              {sending || isDismiss ? (
                <span {...stylex.props(styles.optionTrail)}>
                  {sending ? (
                    <Spinner size="small" />
                  ) : (
                    <span aria-hidden="true" {...stylex.props(styles.keyHint)}>
                      <Kbd>esc</Kbd>
                    </span>
                  )}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {error ? (
        <p role="alert" {...stylex.props(styles.status, styles.statusError)}>
          {error}
        </p>
      ) : !isReady ? (
        <p {...stylex.props(styles.status)}>
          {t('sessions.permission.connecting', 'Connecting to the workspace…')}
        </p>
      ) : null}
    </div>
  );
}

/** Whether a line only says again what the question already asked. */
const restates = (text: string, heading: string) => {
  const words = (value: string) =>
    new Set(
      value
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 3)
    );
  const headingWords = words(heading);
  if (headingWords.size === 0) return false;
  const textWords = words(text);
  let shared = 0;
  for (const word of headingWords) if (textWords.has(word)) shared++;
  // Everything the question names is in the line, and the line adds at most a
  // word or two: "Allow network access?" over "https network access to host"
  // still carries the host, so this is deliberately strict.
  return shared === headingWords.size && textWords.size <= headingWords.size;
};

const QUESTION_KEYS: Record<PermissionQuestionKind, string> = {
  command: 'sessions.permission.question.command',
  edit: 'sessions.permission.question.edit',
  delete: 'sessions.permission.question.delete',
  move: 'sessions.permission.question.move',
  read: 'sessions.permission.question.read',
  search: 'sessions.permission.question.search',
  fetch: 'sessions.permission.question.fetch',
  plan: 'sessions.permission.question.plan',
  tool: 'sessions.permission.question.tool',
};

function PositionControl({ position }: { position: PermissionPromptPosition }) {
  const { t } = useTranslation();
  return (
    <>
      <Button
        variant="ghost"
        size="small"
        icon
        aria-label={t('sessions.permission.previous', 'Previous request')}
        onClick={position.onPrevious}
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
      <span {...stylex.props(styles.positionLabel)}>
        {t('sessions.permission.position', '{{index}}/{{total}}', {
          index: position.index + 1,
          total: position.total,
        })}
      </span>
      <Button
        variant="ghost"
        size="small"
        icon
        aria-label={t('sessions.permission.next', 'Next request')}
        onClick={position.onNext}
      >
        <ChevronRight aria-hidden="true" />
      </Button>
    </>
  );
}

// =============================================================================
// The live surface
// =============================================================================

export interface FloatingPermissionRequestProps {
  sessionId: SessionId;
  sessionStatus: SessionStatus | undefined;
  sessionHistory: SessionDoc['history'] | undefined;
  /** Stop the agent instead of answering; the composer holding Stop is hidden. */
  onStop?: () => void;
}

type Sending = { requestId: string; optionId: string } | null;
type SendError = { requestId: string; message: string } | null;

/**
 * Where a person answers what the agent is waiting on. It takes the composer's
 * place — the answer is the next thing the conversation needs from them — and
 * it is the ONLY live surface: the conversation shows the request's place in
 * the turn, never a second set of buttons.
 *
 * Requests are asked one at a time. Several can be pending (parallel tool
 * calls); the prompt says which one of how many this is and walks between
 * them, and answering one brings up the next in the same place.
 */
export function FloatingPermissionRequest({
  sessionId,
  sessionStatus,
  sessionHistory,
  onStop,
}: FloatingPermissionRequestProps) {
  const { t } = useTranslation();
  const { respondToPermission, isReady } = usePermissionResponse();
  const askQuestionScrollRef = useRef<HTMLDivElement>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [sending, setSending] = useState<Sending>(null);
  const [sendError, setSendError] = useState<SendError>(null);
  const lastIndexRef = useRef(0);

  const pendingList = useMemo(() => {
    if (sessionStatus?.type !== 'requestPermission' && sessionStatus?.type !== 'running') return [];
    return findPendingPermissions(sessionHistory);
  }, [sessionStatus, sessionHistory]);

  useKeyboardAwareScrollIntoView(askQuestionScrollRef);

  // The request on screen: the one chosen, or — once it is answered and gone —
  // the one that took its place, so answering walks forward rather than back.
  const selectedIndex = pendingList.findIndex(
    (entry) => entry.permission.requestId === selectedRequestId
  );
  const index =
    selectedIndex !== -1
      ? selectedIndex
      : Math.min(lastIndexRef.current, Math.max(0, pendingList.length - 1));
  lastIndexRef.current = index;
  const current = pendingList[index];

  const respond = useCallback(
    async (
      entry: PendingPermission,
      optionId: string,
      outcome: Parameters<typeof respondToPermission>[2]
    ) => {
      if (!isReady || sending) return;
      setSending({ requestId: entry.permission.requestId, optionId });
      setSendError(null);
      try {
        await respondToPermission(sessionId, entry.permission.requestId, outcome, {
          turnId: entry.turnId,
        });
      } catch (error) {
        console.error('Failed to respond to permission request:', error);
        setSendError({
          requestId: entry.permission.requestId,
          message: t(
            'sessions.permission.sendFailed',
            "Your answer didn't reach the agent. Try again."
          ),
        });
      } finally {
        setSending(null);
      }
    },
    [isReady, respondToPermission, sending, sessionId, t]
  );

  if (!current) return null;

  const requestId = current.permission.requestId;
  const sendingOptionId = sending?.requestId === requestId ? sending.optionId : null;
  const error = sendError?.requestId === requestId ? sendError.message : null;
  const position: PermissionPromptPosition | undefined =
    pendingList.length > 1
      ? {
          index,
          total: pendingList.length,
          onPrevious: () =>
            setSelectedRequestId(
              pendingList[(index - 1 + pendingList.length) % pendingList.length]!.permission
                .requestId
            ),
          onNext: () =>
            setSelectedRequestId(
              pendingList[(index + 1) % pendingList.length]!.permission.requestId
            ),
        }
      : undefined;

  if (current.isAskUserQuestion) {
    // A question is a form rather than a yes or no, and it replaces the
    // composer's keyboard behaviour: lift on iOS, resize naturally on Android,
    // and keep a focused custom-answer field visible inside the cap.
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
        <ConversationColumn>
          {position ? (
            <div {...stylex.props(styles.queueStrip)}>
              <PositionControl position={position} />
            </div>
          ) : null}
          <QuestionRequest
            key={requestId}
            entry={current}
            isReady={isReady}
            sendingOptionId={sendingOptionId}
            onRespond={respond}
          />
        </ConversationColumn>
      </ScrollArea>
    );
  }

  return (
    <div className="mx-3 mb-2">
      <ConversationColumn>
        <PermissionPrompt
          key={requestId}
          toolCall={current.toolCall}
          permission={current.permission}
          isReady={isReady}
          sendingOptionId={sendingOptionId}
          error={error}
          position={position}
          onStop={onStop}
          autoFocus
          onSelect={(optionId) => {
            void respond(current, optionId, { outcome: 'selected', optionId });
          }}
        />
      </ConversationColumn>
    </div>
  );
}

const getOptionIdByKind = (
  options: PermissionOption[],
  predicate: (option: PermissionOption) => boolean
): string | null => options.find(predicate)?.optionId ?? null;

function QuestionRequest({
  entry,
  isReady,
  sendingOptionId,
  onRespond,
}: {
  entry: PendingPermission;
  isReady: boolean;
  sendingOptionId: string | null;
  onRespond: (
    entry: PendingPermission,
    optionId: string,
    outcome: Parameters<ReturnType<typeof usePermissionResponse>['respondToPermission']>[2]
  ) => Promise<void>;
}) {
  const permission = entry.permission;
  const meta = useMemo(
    () => parseAskUserQuestionPermissionMeta(permission._meta),
    [permission._meta]
  );
  const { answerOptionId, cancelOptionId } = useMemo(() => {
    const options = permission.options;
    const answer =
      getOptionIdByKind(options, (option) => option.optionId === 'answer') ??
      getOptionIdByKind(options, (option) => option.kind?.startsWith('allow') === true) ??
      options[0]?.optionId ??
      null;
    const cancel =
      getOptionIdByKind(
        options,
        (option) =>
          option.optionId !== answer &&
          (option.kind?.startsWith('deny') === true || option.kind?.startsWith('reject') === true)
      ) ??
      options.find((option) => option.optionId !== answer)?.optionId ??
      null;
    return { answerOptionId: answer, cancelOptionId: cancel };
  }, [permission.options]);

  if (!meta) return null;

  return (
    <AskUserQuestionCard
      meta={meta}
      mode={{
        kind: 'interactive',
        isReady,
        disabled: false,
        isPendingSubmit: sendingOptionId !== null && sendingOptionId === answerOptionId,
        isPendingCancel: sendingOptionId !== null && sendingOptionId === cancelOptionId,
        onSubmit: (answers: AskUserQuestionAnswers) => {
          if (!answerOptionId) return;
          void onRespond(
            entry,
            answerOptionId,
            createAskUserQuestionPermissionOutcome(answerOptionId, answers, meta)
          );
        },
        onCancel: () => {
          if (!cancelOptionId) return;
          void onRespond(entry, cancelOptionId, { outcome: 'selected', optionId: cancelOptionId });
        },
      }}
    />
  );
}

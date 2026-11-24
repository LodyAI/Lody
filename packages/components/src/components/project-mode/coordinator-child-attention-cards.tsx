import * as stylex from '@stylexjs/stylex';
import {
  buildSessionTurnInputConfig,
  createAskUserQuestionPermissionOutcome,
  getServerNow,
  isAskUserQuestionPermissionMeta,
  parseAskUserQuestionPermissionMeta,
  type AskUserQuestionAnswers,
  type MessageContent,
  type SessionHistory,
  type SessionId,
} from '@lody/shared';
import { Spinner } from '@lody/ui/spinner';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { useAtomValue } from 'jotai';
import {
  ArrowUp,
  Check,
  ExternalLink,
  MessageSquarePlus,
  MessageSquareWarning,
  ShieldAlert,
  X,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { userAtom } from '@/atoms';
import { AskUserQuestionCard } from '@/components/sessions/ask-user-question-card';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { usePermissionResponse } from '@/hooks/use-permission-response';
import { useSessionDoc } from '@/hooks/use-session-doc';
import { useConversationTail } from '@/hooks/use-conversation-view';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import {
  resolveDismissOptionId,
  resolvePermissionHeading,
  resolvePermissionOptionTone,
  resolvePermissionQuestionKind,
  resolvePermissionReason,
  resolvePermissionSubject,
  resolveSuggestedOptionId,
  type PermissionOption,
  type PermissionQuestionKind,
  type PermissionRequest,
} from '@/lib/permission-request-presentation';
import { useCoordinatorConversation } from './coordinator-conversation';
import { formatTaskNumber } from './project-board';
import type { ProjectBoardRow } from './project-board-model';

type ToolCallContent = Extract<MessageContent, { type: 'tool_call' }>;

export type CoordinatorPreviewChildAttentionItem = {
  readonly sessionId: SessionId;
  readonly taskNumber: number | null;
  readonly taskTitle: string;
  readonly turnId: string;
  readonly toolCall: ToolCallContent;
  readonly permission: PermissionRequest;
  readonly onSelectOption?: (optionId: string) => Promise<void> | void;
  readonly onRejectWithFeedback?: (feedback: string) => Promise<void> | void;
};

interface PendingChildPermission {
  turnId: string;
  toolCall: ToolCallContent;
  permission: PermissionRequest;
  isAskUserQuestion: boolean;
}

const MONO = 'var(--font-mono, ui-monospace, monospace)';
const REGION_BLOCK = `color-mix(in oklab, transparent, ${colors.label} 4.5%)`;
const WARNING_BADGE_BG = `color-mix(in oklab, transparent, ${colors.warning} 15%)`;
const WARNING_BORDER = `color-mix(in oklab, transparent, ${colors.warning} 34%)`;

const KIND_FALLBACK_LABELS: Record<PermissionQuestionKind, [key: string, fallback: string]> = {
  command: ['projectMode.childAttention.kindCommand', 'Run terminal command?'],
  edit: ['projectMode.childAttention.kindEdit', 'Edit workspace files?'],
  delete: ['projectMode.childAttention.kindDelete', 'Delete workspace files?'],
  move: ['projectMode.childAttention.kindMove', 'Move or rename files?'],
  read: ['projectMode.childAttention.kindRead', 'Read protected file?'],
  search: ['projectMode.childAttention.kindSearch', 'Search workspace?'],
  fetch: ['projectMode.childAttention.kindFetch', 'Fetch external resource?'],
  plan: ['projectMode.childAttention.kindPlan', 'Approve proposed plan?'],
  tool: ['projectMode.childAttention.kindTool', 'Allow tool execution?'],
};

const styles = stylex.create({
  columnWrap: {
    paddingTop: space[1.5],
    paddingBottom: space[2],
  },
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    width: '100%',
    maxWidth: 640,
    minWidth: 0,
  },
  card: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    width: '100%',
    minWidth: 0,
    padding: space[3],
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: WARNING_BORDER,
    borderRadius: radius.large,
    cornerShape: corner.shape,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
    color: colors.label,
  },
  topBar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[1.5],
    minWidth: 0,
  },
  topLeft: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[1.5],
    minWidth: 0,
  },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 22,
    paddingInline: space[2],
    borderRadius: radius.full,
    backgroundColor: WARNING_BADGE_BG,
    color: colors.warning,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 600,
    flexShrink: 0,
  },
  taskBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    height: 22,
    maxWidth: 320,
    minWidth: 0,
    paddingInline: space[2],
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: { default: colors.wellBackground, ':hover': colors.hoverFill },
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    cursor: 'pointer',
  },
  taskNum: {
    flexShrink: 0,
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
    color: colors.label,
  },
  taskTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  openLinkBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 22,
    paddingInline: space[1.5],
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.tertiaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    cursor: 'pointer',
    flexShrink: 0,
  },
  topRight: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    flexShrink: 0,
  },
  dismissIconBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.tertiaryLabel,
    cursor: 'pointer',
    flexShrink: 0,
  },

  headingBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    minWidth: 0,
  },
  heading: {
    margin: 0,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    fontWeight: 600,
    color: colors.label,
  },
  reason: {
    margin: 0,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    color: colors.secondaryLabel,
    overflowWrap: 'anywhere',
  },
  subjectBox: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    maxHeight: '9.5em',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    paddingBlock: space[2],
    paddingInline: space[3],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: REGION_BLOCK,
    fontFamily: MONO,
    fontSize: text.footnoteSize,
    lineHeight: '18px',
    color: colors.label,
  },
  subjectCode: {
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  subjectCwd: {
    color: colors.tertiaryLabel,
    fontSize: '11px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  questionExcerpt: {
    margin: 0,
    paddingBlock: space[2],
    paddingInline: space[3],
    borderRadius: radius.medium,
    backgroundColor: REGION_BLOCK,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    color: colors.label,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },

  actionsRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[1.5],
    paddingTop: 2,
  },
  btn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[1.5],
    minHeight: 30,
    paddingBlock: 4,
    paddingInline: space[3],
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    borderRadius: radius.medium,
    backgroundColor: { default: colors.background, ':hover': colors.hoverFill },
    color: colors.label,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 500,
    cursor: 'pointer',
    transitionProperty: 'background-color, border-color, opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  btnPrimary: {
    backgroundColor: { default: colors.accent, ':hover': colors.accent },
    borderColor: colors.accent,
    color: colors.onAccent,
    opacity: { default: 1, ':hover': 0.9 },
  },
  btnReject: {
    color: colors.secondaryLabel,
  },
  btnDisabled: {
    opacity: 0.55,
    cursor: 'not-allowed',
  },
  feedbackToggleBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    minHeight: 30,
    paddingBlock: 4,
    paddingInline: space[2],
    borderWidth: 0,
    borderRadius: radius.medium,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
    cursor: 'pointer',
  },

  composerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    padding: 4,
    paddingLeft: space[2],
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    borderRadius: radius.medium,
    backgroundColor: colors.background,
  },
  composerInput: {
    flex: 1,
    minWidth: 0,
    height: 28,
    padding: 0,
    borderWidth: 0,
    outlineStyle: 'none',
    backgroundColor: 'transparent',
    color: colors.label,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
  },
  composerSendBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: colors.accent,
    color: colors.onAccent,
    cursor: 'pointer',
    flexShrink: 0,
  },
  composerCancelBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.tertiaryLabel,
    cursor: 'pointer',
    flexShrink: 0,
  },
  resolvedBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    paddingBlock: 6,
    paddingInline: space[2],
    borderRadius: radius.medium,
    backgroundColor: REGION_BLOCK,
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
  resolvedIcon: {
    flexShrink: 0,
    color: colors.success,
  },
  errorText: {
    margin: 0,
    color: colors.destructive,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
  spinner: {
    width: 13,
    height: 13,
    flexShrink: 0,
  },
});

function findPendingChildPermissions(
  turns: readonly (SessionHistory | null)[]
): PendingChildPermission[] {
  const out: PendingChildPermission[] = [];
  for (const turn of turns) {
    if (!turn) continue;
    const items = (turn.items ?? []) as unknown as MessageContent[];
    for (const item of items) {
      if (
        item &&
        item.type === 'tool_call' &&
        (item as ToolCallContent).permissionRequest &&
        !(item as ToolCallContent).permissionRequest?.outcome
      ) {
        const toolCall = item as ToolCallContent;
        const permission = toolCall.permissionRequest!;
        out.push({
          turnId: turn.id,
          toolCall,
          permission,
          isAskUserQuestion: isAskUserQuestionPermissionMeta(permission._meta),
        });
      }
    }
  }
  return out;
}

function findLatestChildAssistantQuestion(
  turns: readonly (SessionHistory | null)[]
): string | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (!turn || turn.role !== 'assistant') continue;
    const items = (turn.items ?? []) as unknown as MessageContent[];
    for (let j = items.length - 1; j >= 0; j -= 1) {
      const item = items[j];
      if (!item) continue;
      if (item.type === 'text' && item.text.trim().length > 0) {
        return item.text.trim().slice(0, 360);
      }
      if (item.type === 'coordinator_message' && item.body.trim().length > 0) {
        return item.body.trim().slice(0, 360);
      }
    }
  }
  return null;
}

function PermissionCardContent({
  taskNumber,
  taskTitle,
  toolCall,
  permission,
  isReady,
  onOpenTask,
  onDismiss,
  onSelectOption,
  onRejectWithFeedback,
}: {
  taskNumber: number | null;
  taskTitle: string;
  toolCall: ToolCallContent;
  permission: PermissionRequest;
  isReady: boolean;
  onOpenTask?: () => void;
  onDismiss?: () => void;
  onSelectOption: (optionId: string) => Promise<void>;
  onRejectWithFeedback?: (dismissOptionId: string | null, feedback: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [sendingOptionId, setSendingOptionId] = useState<string | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [sendingFeedback, setSendingFeedback] = useState(false);
  const [resolvedSummary, setResolvedSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const taskTag = formatTaskNumber(taskNumber);
  const questionKind = resolvePermissionQuestionKind(toolCall.kind);
  const [fallbackKey, fallbackText] = KIND_FALLBACK_LABELS[questionKind];
  const heading = resolvePermissionHeading(permission) ?? t(fallbackKey, fallbackText);
  const reason = resolvePermissionReason(permission);
  const subject = resolvePermissionSubject(toolCall);
  const suggestedId = resolveSuggestedOptionId(permission);
  const dismissOptionId = resolveDismissOptionId(permission.options);

  const orderedOptions = useMemo(() => {
    const allow: PermissionOption[] = [];
    const reject: PermissionOption[] = [];
    for (const opt of permission.options) {
      const tone = resolvePermissionOptionTone(opt);
      if (tone === 'reject' || tone === 'rejectAlways') {
        reject.push(opt);
      } else {
        allow.push(opt);
      }
    }
    return [...allow, ...reject];
  }, [permission.options]);

  const busy = !isReady || sendingOptionId !== null || sendingFeedback;

  const handleOptionClick = async (option: PermissionOption) => {
    if (busy) return;
    setError(null);
    setSendingOptionId(option.optionId);
    try {
      await onSelectOption(option.optionId);
      setResolvedSummary(option.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSendingOptionId(null);
    }
  };

  const handleSubmitFeedback = async () => {
    const trimmed = feedbackText.trim();
    if (!trimmed || !onRejectWithFeedback || busy) return;
    setError(null);
    setSendingFeedback(true);
    try {
      await onRejectWithFeedback(dismissOptionId, trimmed);
      setResolvedSummary(trimmed);
      setFeedbackText('');
      setFeedbackOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSendingFeedback(false);
    }
  };

  return (
    <div {...stylex.props(styles.card)} data-coordinator-child-permission-card="">
      <div {...stylex.props(styles.topBar)}>
        <div {...stylex.props(styles.topLeft)}>
          <span {...stylex.props(styles.badge)}>
            <ShieldAlert size={12} aria-hidden="true" />
            <span>{t('projectMode.childAttention.permissionBadge', 'Permission request')}</span>
          </span>
          <button
            type="button"
            title={taskTitle}
            onClick={onOpenTask}
            {...stylex.props(styles.taskBtn)}
          >
            {taskTag ? <span {...stylex.props(styles.taskNum)}>{taskTag}</span> : null}
            <span {...stylex.props(styles.taskTitle)}>{taskTitle}</span>
          </button>
        </div>
        {onOpenTask || onDismiss ? (
          <div {...stylex.props(styles.topRight)}>
            {onOpenTask ? (
              <button type="button" onClick={onOpenTask} {...stylex.props(styles.openLinkBtn)}>
                <span>{t('projectMode.childAttention.openChild', 'Open task')}</span>
                <ExternalLink size={11} aria-hidden="true" />
              </button>
            ) : null}
            {onDismiss ? (
              <button
                type="button"
                onClick={onDismiss}
                title={t('projectMode.card.dismiss', 'Dismiss')}
                aria-label={t('projectMode.card.dismiss', 'Dismiss')}
                data-coordinator-card-dismiss=""
                {...stylex.props(styles.dismissIconBtn)}
              >
                <X size={14} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div {...stylex.props(styles.headingBlock)}>
        <h4 {...stylex.props(styles.heading)}>{heading}</h4>
        {reason ? <p {...stylex.props(styles.reason)}>{reason}</p> : null}
      </div>

      {subject ? (
        <div {...stylex.props(styles.subjectBox)}>
          {subject.type === 'command' ? (
            <>
              <span {...stylex.props(styles.subjectCode)}>{subject.command}</span>
              {subject.cwd ? <span {...stylex.props(styles.subjectCwd)}>{subject.cwd}</span> : null}
            </>
          ) : subject.type === 'paths' ? (
            subject.paths.map((p) => (
              <span key={p} {...stylex.props(styles.subjectCode)}>
                {p}
              </span>
            ))
          ) : (
            <span {...stylex.props(styles.subjectCode)}>{subject.text}</span>
          )}
        </div>
      ) : null}

      {error ? <p {...stylex.props(styles.errorText)}>{error}</p> : null}

      {resolvedSummary ? (
        <div {...stylex.props(styles.resolvedBanner)}>
          <Check size={13} {...stylex.props(styles.resolvedIcon)} aria-hidden="true" />
          <span>{resolvedSummary}</span>
        </div>
      ) : (
        <>
          <div {...stylex.props(styles.actionsRow)}>
            {orderedOptions.map((option, index) => {
              const tone = resolvePermissionOptionTone(option);
              const isReject = tone === 'reject' || tone === 'rejectAlways';
              const isPrimary =
                !isReject &&
                (option.optionId === suggestedId || (suggestedId === null && index === 0));
              const isSendingThis = sendingOptionId === option.optionId;
              return (
                <button
                  key={option.optionId}
                  type="button"
                  disabled={busy}
                  data-coordinator-permission-option={option.optionId}
                  onClick={() => {
                    void handleOptionClick(option);
                  }}
                  {...stylex.props(
                    styles.btn,
                    isPrimary && styles.btnPrimary,
                    isReject && styles.btnReject,
                    busy && styles.btnDisabled
                  )}
                >
                  {isSendingThis ? <Spinner {...stylex.props(styles.spinner)} /> : null}
                  <span>{option.name}</span>
                </button>
              );
            })}
            {onRejectWithFeedback && !feedbackOpen ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setFeedbackOpen(true);
                  requestAnimationFrame(() => inputRef.current?.focus());
                }}
                data-coordinator-permission-feedback-toggle=""
                {...stylex.props(styles.feedbackToggleBtn)}
              >
                <MessageSquarePlus size={13} aria-hidden="true" />
                <span>
                  {t(
                    'projectMode.childAttention.rejectAndFeedback',
                    'Reject & give other feedback…'
                  )}
                </span>
              </button>
            ) : null}
          </div>

          {feedbackOpen ? (
            <div {...stylex.props(styles.composerRow)}>
              <input
                ref={inputRef}
                type="text"
                value={feedbackText}
                disabled={sendingFeedback}
                placeholder={t(
                  'projectMode.childAttention.feedbackPlaceholder',
                  'Tell this task what to do instead…'
                )}
                onChange={(event) => setFeedbackText(event.target.value)}
                onKeyDown={(event) => {
                  if (isImeComposingKeyboardEvent(event)) return;
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void handleSubmitFeedback();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    setFeedbackOpen(false);
                  }
                }}
                data-coordinator-permission-feedback-input=""
                {...stylex.props(styles.composerInput)}
              />
              <button
                type="button"
                onClick={() => setFeedbackOpen(false)}
                disabled={sendingFeedback}
                aria-label={t('common.cancel', 'Cancel')}
                {...stylex.props(styles.composerCancelBtn)}
              >
                <X size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                disabled={!feedbackText.trim() || sendingFeedback}
                onClick={() => {
                  void handleSubmitFeedback();
                }}
                aria-label={t('projectMode.card.sendFeedback', 'Send feedback')}
                data-coordinator-permission-feedback-send=""
                {...stylex.props(
                  styles.composerSendBtn,
                  (!feedbackText.trim() || sendingFeedback) && styles.btnDisabled
                )}
              >
                {sendingFeedback ? (
                  <Spinner {...stylex.props(styles.spinner)} />
                ) : (
                  <ArrowUp size={14} aria-hidden="true" />
                )}
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function LiveChildAttentionCard({
  row,
  onOpenTask,
}: {
  row: ProjectBoardRow & { session: NonNullable<ProjectBoardRow['session']> };
  onOpenTask: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const currentUser = useAtomValue(userAtom);
  const childSessionId = row.session.id;
  const { history, addHistory } = useSessionDoc(childSessionId);
  const { availableTurns } = useConversationTail(history, { extendToLastUserTurn: true });
  const { respondToPermission, isReady } = usePermissionResponse();
  const [questionSendingOptionId, setQuestionSendingOptionId] = useState<string | null>(null);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [sendingReply, setSendingReply] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  const pendingPermissions = useMemo(
    () => findPendingChildPermissions(availableTurns),
    [availableTurns]
  );
  const activePermission = pendingPermissions[0] ?? null;
  const awaitingTextExcerpt = useMemo(
    () =>
      !activePermission && typeof row.session.awaitingUserSince === 'number'
        ? findLatestChildAssistantQuestion(availableTurns)
        : null,
    [activePermission, availableTurns, row.session.awaitingUserSince]
  );
  const activeAttentionKey = activePermission
    ? `perm:${activePermission.turnId}:${activePermission.permission.requestId}`
    : awaitingTextExcerpt
      ? `await:${String(row.session.awaitingUserSince)}`
      : null;

  if (activeAttentionKey && dismissedKey === activeAttentionKey) {
    return null;
  }

  const taskTitle = row.session.title?.trim() || t('sessions.untitled', 'Untitled session');
  const taskTag = formatTaskNumber(row.taskNumber);

  const dispatchMessageToChild = async (prompt: string) => {
    const trimmed = prompt.trim();
    const userId = currentUser?.id ?? row.session.userId;
    if (!trimmed || !userId) return;
    const inputConfig = buildSessionTurnInputConfig({
      prompt: trimmed,
      inputBlocks: [{ type: 'text', text: trimmed }],
      cliType: row.session.cliType,
      agentType: row.session.agentType,
      ...(row.session.acpSessionId ? { resume: row.session.acpSessionId } : {}),
    });
    await addHistory(
      {
        role: 'user',
        userId,
        timestamp: new Date(getServerNow()).toISOString(),
        status: 'pending',
        read: false,
        finished: true,
        items: [{ type: 'text', text: trimmed }],
        fileDiff: [],
        inputConfig,
      },
      { dispatch: true }
    );
  };

  if (activePermission && activePermission.isAskUserQuestion) {
    const meta = parseAskUserQuestionPermissionMeta(activePermission.permission._meta);
    if (!meta) return null;
    const options = activePermission.permission.options;
    const answerOptionId =
      options.find((opt) => opt.optionId === 'answer')?.optionId ??
      options.find((opt) => opt.kind?.startsWith('allow') === true)?.optionId ??
      options[0]?.optionId ??
      null;
    const cancelOptionId =
      options.find(
        (opt) =>
          opt.optionId !== answerOptionId &&
          (opt.kind?.startsWith('deny') === true || opt.kind?.startsWith('reject') === true)
      )?.optionId ??
      options.find((opt) => opt.optionId !== answerOptionId)?.optionId ??
      null;

    return (
      <div {...stylex.props(styles.card)} data-coordinator-child-question-card="">
        <div {...stylex.props(styles.topBar)}>
          <div {...stylex.props(styles.topLeft)}>
            <span {...stylex.props(styles.badge)}>
              <MessageSquareWarning size={12} aria-hidden="true" />
              <span>{t('projectMode.childAttention.questionBadge', 'Question from task')}</span>
            </span>
            <button
              type="button"
              title={taskTitle}
              onClick={() => onOpenTask(childSessionId)}
              {...stylex.props(styles.taskBtn)}
            >
              {taskTag ? <span {...stylex.props(styles.taskNum)}>{taskTag}</span> : null}
              <span {...stylex.props(styles.taskTitle)}>{taskTitle}</span>
            </button>
          </div>
          <div {...stylex.props(styles.topRight)}>
            <button
              type="button"
              onClick={() => onOpenTask(childSessionId)}
              {...stylex.props(styles.openLinkBtn)}
            >
              <span>{t('projectMode.childAttention.openChild', 'Open task')}</span>
              <ExternalLink size={11} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setDismissedKey(activeAttentionKey)}
              title={t('projectMode.card.dismiss', 'Dismiss')}
              aria-label={t('projectMode.card.dismiss', 'Dismiss')}
              data-coordinator-card-dismiss=""
              {...stylex.props(styles.dismissIconBtn)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
        <AskUserQuestionCard
          meta={meta}
          mode={{
            kind: 'interactive',
            isReady,
            disabled: false,
            error: questionError,
            isPendingSubmit:
              questionSendingOptionId !== null && questionSendingOptionId === answerOptionId,
            isPendingCancel:
              questionSendingOptionId !== null && questionSendingOptionId === cancelOptionId,
            onSubmit: (answers: AskUserQuestionAnswers) => {
              if (!answerOptionId) return;
              setQuestionError(null);
              setQuestionSendingOptionId(answerOptionId);
              void respondToPermission(
                childSessionId,
                activePermission.permission.requestId,
                createAskUserQuestionPermissionOutcome(answerOptionId, answers, meta),
                { turnId: activePermission.turnId }
              )
                .catch((err: unknown) => {
                  setQuestionError(err instanceof Error ? err.message : String(err));
                })
                .finally(() => setQuestionSendingOptionId(null));
            },
            onCancel: () => {
              if (!cancelOptionId) return;
              setQuestionError(null);
              setQuestionSendingOptionId(cancelOptionId);
              void respondToPermission(
                childSessionId,
                activePermission.permission.requestId,
                { outcome: 'selected', optionId: cancelOptionId },
                { turnId: activePermission.turnId }
              )
                .catch((err: unknown) => {
                  setQuestionError(err instanceof Error ? err.message : String(err));
                })
                .finally(() => setQuestionSendingOptionId(null));
            },
          }}
        />
      </div>
    );
  }

  if (activePermission) {
    return (
      <PermissionCardContent
        taskNumber={row.taskNumber}
        taskTitle={taskTitle}
        toolCall={activePermission.toolCall}
        permission={activePermission.permission}
        isReady={isReady}
        onOpenTask={() => onOpenTask(childSessionId)}
        onDismiss={() => setDismissedKey(activeAttentionKey)}
        onSelectOption={(optionId) =>
          respondToPermission(
            childSessionId,
            activePermission.permission.requestId,
            { outcome: 'selected', optionId },
            { turnId: activePermission.turnId }
          )
        }
        onRejectWithFeedback={async (dismissOptionId, feedback) => {
          if (dismissOptionId) {
            await respondToPermission(
              childSessionId,
              activePermission.permission.requestId,
              { outcome: 'selected', optionId: dismissOptionId },
              { turnId: activePermission.turnId }
            );
          }
          await dispatchMessageToChild(feedback);
        }}
      />
    );
  }

  if (awaitingTextExcerpt) {
    return (
      <div {...stylex.props(styles.card)} data-coordinator-child-question-card="">
        <div {...stylex.props(styles.topBar)}>
          <div {...stylex.props(styles.topLeft)}>
            <span {...stylex.props(styles.badge)}>
              <MessageSquareWarning size={12} aria-hidden="true" />
              <span>{t('projectMode.childAttention.awaitingReplyBadge', 'Waiting for reply')}</span>
            </span>
            <button
              type="button"
              title={taskTitle}
              onClick={() => onOpenTask(childSessionId)}
              {...stylex.props(styles.taskBtn)}
            >
              {taskTag ? <span {...stylex.props(styles.taskNum)}>{taskTag}</span> : null}
              <span {...stylex.props(styles.taskTitle)}>{taskTitle}</span>
            </button>
          </div>
          <div {...stylex.props(styles.topRight)}>
            <button
              type="button"
              onClick={() => onOpenTask(childSessionId)}
              {...stylex.props(styles.openLinkBtn)}
            >
              <span>{t('projectMode.childAttention.openChild', 'Open task')}</span>
              <ExternalLink size={11} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setDismissedKey(activeAttentionKey)}
              title={t('projectMode.card.dismiss', 'Dismiss')}
              aria-label={t('projectMode.card.dismiss', 'Dismiss')}
              data-coordinator-card-dismiss=""
              {...stylex.props(styles.dismissIconBtn)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
        <p {...stylex.props(styles.questionExcerpt)}>{awaitingTextExcerpt}</p>
        <div {...stylex.props(styles.composerRow)}>
          <input
            type="text"
            value={replyText}
            disabled={sendingReply}
            placeholder={t(
              'projectMode.childAttention.replyPlaceholder',
              'Reply directly to this task…'
            )}
            onChange={(event) => setReplyText(event.target.value)}
            onKeyDown={(event) => {
              if (isImeComposingKeyboardEvent(event)) return;
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (!replyText.trim() || sendingReply) return;
                setSendingReply(true);
                void dispatchMessageToChild(replyText)
                  .then(() => setReplyText(''))
                  .finally(() => setSendingReply(false));
              }
            }}
            {...stylex.props(styles.composerInput)}
          />
          <button
            type="button"
            disabled={!replyText.trim() || sendingReply}
            onClick={() => {
              if (!replyText.trim() || sendingReply) return;
              setSendingReply(true);
              void dispatchMessageToChild(replyText)
                .then(() => setReplyText(''))
                .finally(() => setSendingReply(false));
            }}
            aria-label={t('projectMode.card.sendFeedback', 'Send feedback')}
            {...stylex.props(
              styles.composerSendBtn,
              (!replyText.trim() || sendingReply) && styles.btnDisabled
            )}
          >
            {sendingReply ? (
              <Spinner {...stylex.props(styles.spinner)} />
            ) : (
              <ArrowUp size={14} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    );
  }

  return null;
}

/**
 * Surfaces live permission requests and user-facing questions from blocked child
 * conversations directly inside the coordinator conversation stream so the user
 * can approve, answer, or send alternative instructions without switching tabs.
 */
export function CoordinatorChildAttentionCards() {
  const coordinator = useCoordinatorConversation();
  const needsYouRows = useMemo(() => {
    if (!coordinator) return [];
    const list: Array<ProjectBoardRow & { session: NonNullable<ProjectBoardRow['session']> }> = [];
    const seen = new Set<string>();
    for (const row of coordinator.tasks.values()) {
      if (row.bucket === 'needsYou' && row.session && !seen.has(row.session.id)) {
        seen.add(row.session.id);
        list.push(row as ProjectBoardRow & { session: NonNullable<ProjectBoardRow['session']> });
      }
    }
    list.sort((a, b) => b.latestMessageAt - a.latestMessageAt);
    return list;
  }, [coordinator]);

  const previewItems = coordinator?.previewChildAttention;
  if (!coordinator || (needsYouRows.length === 0 && (!previewItems || previewItems.length === 0))) {
    return null;
  }

  return (
    <ConversationColumn {...stylex.props(styles.columnWrap)}>
      <div {...stylex.props(styles.stack)} data-coordinator-child-attention-stack="">
        {previewItems?.map((item) => (
          <PermissionCardContent
            key={`preview:${item.sessionId}:${item.permission.requestId}`}
            taskNumber={item.taskNumber}
            taskTitle={item.taskTitle}
            toolCall={item.toolCall}
            permission={item.permission}
            isReady
            onOpenTask={() => coordinator.openTask(item.sessionId)}
            onSelectOption={async (optionId) => {
              await item.onSelectOption?.(optionId);
            }}
            onRejectWithFeedback={async (_dismissId, feedback) => {
              await item.onRejectWithFeedback?.(feedback);
            }}
          />
        ))}
        {needsYouRows.map((row) => (
          <LiveChildAttentionCard
            key={row.session.id}
            row={row}
            onOpenTask={coordinator.openTask}
          />
        ))}
      </div>
    </ConversationColumn>
  );
}

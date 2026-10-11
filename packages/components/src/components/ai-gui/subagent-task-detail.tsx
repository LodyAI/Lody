import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Check, Copy } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { Button } from '@lody/ui/button';
import { Dialog } from '@/ui/dialog';
import { DEFAULT_CONVERSATION_FONT_SIZE, type ConversationFontSize } from '@/atoms/settings';
import { formatDurationCompact, getDurationUnitLabels } from '@/lib/format-duration';
import { writeTextToClipboard } from '@/lib/clipboard';
import { withClassName } from '@/lib/stylex';
import { styles } from './subagent-task-detail.stylex';
import { styles as panelStyles } from './subagent-task-panel.stylex';
import {
  actorOf,
  durationOf,
  isRunning,
  latestActionOf,
  LiveElapsed,
  meaningfulSummaryOf,
  stateLabel,
  stateOf,
  useUsageLabel,
  type SubagentTask,
} from './subagent-task-state';
import { ToolCommandSection, ToolDetailSheet } from './tool-call-detail';

const SCROLLBAR = 'scrollbar-pro';
const FOLLOW_SLACK_PX = 24;

/** The brief, whole, with one-tap copy. A background command reads as code. */
function TaskBrief({
  task,
  body,
  fontSize,
}: {
  task: SubagentTask;
  body: string;
  fontSize: ConversationFontSize;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const isCommand = task.taskType === 'local_bash';
  return (
    <div {...stylex.props(styles.bodyWrap)}>
      <div
        aria-label={
          isCommand
            ? t('sessions.subagentTasks.command', 'Command')
            : t('sessions.subagentTasks.description', 'Description')
        }
        {...stylex.props(!isCommand && styles.body)}
      >
        {isCommand ? (
          <ToolDetailSheet>
            <div {...stylex.props(styles.commandBrief)}>
              <ToolCommandSection
                command={body}
                shell
                running={isRunning(task)}
                fontSize={fontSize}
              />
            </div>
          </ToolDetailSheet>
        ) : (
          body
        )}
      </div>
      <span {...stylex.props(styles.copy)}>
        <Button
          type="button"
          variant="ghost"
          size="mini"
          icon
          aria-label={copied ? t('common.copied', 'Copied') : t('common.copy', 'Copy')}
          onClick={() => {
            void writeTextToClipboard(body).then((ok) => {
              if (ok) setCopied(true);
            });
          }}
        >
          {copied ? (
            <Check {...stylex.props(panelStyles.glyph)} />
          ) : (
            <Copy {...stylex.props(panelStyles.glyph)} />
          )}
        </Button>
      </span>
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} {...stylex.props(styles.section)}>
      <p aria-hidden="true" {...stylex.props(styles.sectionLabel)}>
        {label}
      </p>
      {children}
    </section>
  );
}

/**
 * The run's own steps, or why there are none. A provider that streams nothing
 * is said to, so a quiet run never reads as a broken stream; a run that lost
 * steps on the way says so under whatever did arrive.
 */
function TaskActivity({
  task,
  renderHistory,
}: {
  task: SubagentTask;
  renderHistory?: (task: SubagentTask) => ReactNode;
}) {
  const { t } = useTranslation();
  const run = task.run;
  if (!run) return null;
  const hasSteps = run.items.length > 0;
  const streams = run.snapshot.support.stream.length > 0;
  const emptyNote = hasSteps
    ? null
    : !streams
      ? t(
          'sessions.subagentTasks.activityNotStreamed',
          'This agent reports its status and result, not its individual steps.'
        )
      : isRunning(task)
        ? t('sessions.subagentTasks.activityWaiting', 'Waiting for the first step…')
        : t('sessions.subagentTasks.activityNone', 'No steps were received.');
  return (
    <Section label={t('sessions.subagentTasks.activity', 'Activity')}>
      {hasSteps && renderHistory ? (
        <div data-subagent-run-history="" {...stylex.props(styles.section)}>
          {renderHistory(task)}
        </div>
      ) : null}
      {emptyNote ? <p {...stylex.props(styles.note)}>{emptyNote}</p> : null}
      {run.snapshot.outputIncomplete ? (
        <p {...stylex.props(styles.note)}>
          {t(
            'sessions.subagentTasks.activityIncomplete',
            'Some steps of this run were not received.'
          )}
        </p>
      ) : null}
    </Section>
  );
}

function CancelTaskAction({
  task,
  onCancel,
}: {
  task: SubagentTask;
  onCancel: (taskId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string>();
  return (
    <>
      {cancelError ? (
        <p role="alert" {...stylex.props(styles.sectionText, styles.danger, styles.actionsError)}>
          {cancelError}
        </p>
      ) : null}
      <Button
        type="button"
        variant="secondary"
        size="small"
        disabled={cancelling}
        onClick={() => {
          void (async () => {
            setCancelling(true);
            setCancelError(undefined);
            try {
              await onCancel(task.taskId);
            } catch (cause) {
              setCancelError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setCancelling(false);
            }
          })();
        }}
      >
        {cancelling ? <Spinner size="small" /> : null}
        {t('sessions.subagentTasks.stop', 'Stop task')}
      </Button>
    </>
  );
}

/**
 * Keeps a scroller pinned to its end while the reader is there, and leaves it
 * alone once they scroll up to read. A running task opens at its latest step; a
 * finished one opens at its brief.
 */
function useFollowEnd(ref: RefObject<HTMLDivElement | null>, follow: boolean, content: unknown) {
  const pinned = useRef(follow);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [ref, content]);
  const onScroll = () => {
    const node = ref.current;
    if (!node) return;
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK_PX;
  };
  return onScroll;
}

/** The task at full depth: what it is, the whole brief, its run, its result, its cost. */
export function SubagentTaskDetail({
  task,
  onCancel,
  runCancellation,
  renderHistory,
  scrollerRef,
  fontSize = DEFAULT_CONVERSATION_FONT_SIZE,
}: {
  task: SubagentTask;
  onCancel?: (taskId: string) => Promise<void>;
  runCancellation: boolean;
  renderHistory?: (task: SubagentTask) => ReactNode;
  /** The column that scrolls; the dialog focuses it on open. */
  scrollerRef: RefObject<HTMLDivElement | null>;
  fontSize?: ConversationFontSize;
}) {
  const { t } = useTranslation();
  const actor = actorOf(task, t);
  const state = stateOf(task);
  const running = isRunning(task);
  const body = task.description?.trim();
  const result = meaningfulSummaryOf(task);
  const duration = durationOf(task);
  const usage = useUsageLabel(task);
  const latest = latestActionOf(task, t);
  // Cancel is offered only where the run says it can be and the machine can
  // address a run: never a fallback to stopping the parent turn.
  const canCancel =
    Boolean(onCancel) &&
    running &&
    task.taskKind === 'subagent' &&
    (task.run ? runCancellation && task.run.snapshot.support.cancel : true);
  const onScroll = useFollowEnd(scrollerRef, running, task);

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>{actor}</Dialog.Title>
        <Dialog.Description>
          {stateLabel(state, t)}
          {running && typeof task.startedAtEpochSeconds === 'number' ? (
            <>
              {' · '}
              <LiveElapsed startedAtEpochSeconds={task.startedAtEpochSeconds} />
            </>
          ) : duration !== null ? (
            ` · ${formatDurationCompact(duration, getDurationUnitLabels(t))}`
          ) : null}
          {usage ? ` · ${usage}` : null}
          {task.run?.snapshot.modelId ? ` · ${task.run.snapshot.modelId}` : null}
        </Dialog.Description>
      </Dialog.Header>

      <div
        ref={scrollerRef}
        tabIndex={-1}
        onScroll={onScroll}
        {...withClassName(stylex.props(styles.detail), SCROLLBAR)}
      >
        {body ? (
          <Section
            label={
              task.taskType === 'local_bash'
                ? t('sessions.subagentTasks.command', 'Command')
                : t('sessions.subagentTasks.brief', 'Brief')
            }
          >
            <TaskBrief task={task} body={body} fontSize={fontSize} />
          </Section>
        ) : null}

        <TaskActivity task={task} renderHistory={renderHistory} />

        {/* A legacy task has no steps; the one line the row shows is all it has. */}
        {!task.run && latest ? (
          <Section label={t('sessions.subagentTasks.latestAction', 'Latest')}>
            <p {...stylex.props(styles.sectionText)}>{latest}</p>
          </Section>
        ) : null}

        {state === 'unknown' ? (
          <p {...stylex.props(styles.note)}>
            {t(
              'sessions.subagentTasks.unknownExplanation',
              'Lody lost track of this run. It may still be running, or may have stopped.'
            )}
          </p>
        ) : null}

        {(state === 'failed' || state === 'cancelled' || state === 'unknown') && task.error ? (
          <Section label={t('sessions.subagentTasks.error', 'Error')}>
            <p {...stylex.props(styles.sectionText, state === 'failed' && styles.danger)}>
              {task.error}
            </p>
          </Section>
        ) : null}

        {!running && result ? (
          <Section label={t('sessions.subagentTasks.result', 'Result')}>
            <p {...stylex.props(styles.sectionText)}>{result}</p>
          </Section>
        ) : null}
      </div>

      {canCancel && onCancel ? (
        <Dialog.Footer>
          <CancelTaskAction task={task} onCancel={onCancel} />
        </Dialog.Footer>
      ) : null}
    </>
  );
}

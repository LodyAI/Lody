import { forwardRef, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Check, ChevronDown, Tag, Zap } from 'lucide-react';
import {
  TASK_SUGGESTED_LABELS,
  type ProjectRef,
  type TaskAgentRef,
  type TaskPriority,
  type TaskStatus,
} from '@lody/shared';
import {
  getTaskPriorityPresentation,
  TASK_PRIORITY_PRESENTATION,
} from './task-priority-presentation';
import { taskLabelPillStyle } from './task-label-presentation';
import type { UnifiedLocalProjectOption } from '@/components/chat/unified-project-selector';
import { cn } from '@/lib/utils';
import { Button } from '@lody/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { Kbd } from '@/ui/kbd';
import { getTaskStatusPresentation, TASK_STATUS_PRESENTATION } from './task-status-presentation';
import { TaskProjectSelector } from './task-project-selector';
import { projectRefKey } from './task-project-key';
import { TASKS_SURFACE_CLASS, tasksMenuClassName, tasksMenuSurfaceStyle } from './tasks-surface';

export type TaskQuickAddSubmit = {
  title: string;
  body: string;
  status: TaskStatus;
  /** Null when the capture left project unset — still a valid create. */
  project: ProjectRef | null;
  /** Null means no priority — the zero-required-fields default. */
  priority: TaskPriority | null;
  labels: string[];
  /**
   * Who would run it. Written to `lastRunConfig`, NOT `agent`: choosing a
   * runner must never by itself enroll the task in automation.
   */
  runAgent: TaskAgentRef | null;
  /** Explicitly entrusted — the only thing that writes `agent`. */
  delegated: boolean;
  createMore: boolean;
};

export type TaskQuickAddDialogProps = {
  open: boolean;
  submitting?: boolean;
  createMore: boolean;
  /** Column the dialog was opened from; the Status chip starts here. */
  initialStatus?: TaskStatus;
  localProjects?: ReadonlyArray<UnifiedLocalProjectOption>;
  /** Agents available to run this task. Empty hides the agent chip entirely. */
  agentOptions?: ReadonlyArray<{ agentConfigId: string; name: string }>;
  repositories?: ReadonlyArray<{ fullName: string; description?: string | null }>;
  latestMessageAtByRepo?: ReadonlyMap<string, number>;
  onAddLocalProject?: () => void;
  onConnectGitRepo?: () => void;
  onCreateMoreChange: (next: boolean) => void;
  /** Called only when there is something to create. */
  onSubmit: (input: TaskQuickAddSubmit) => void;
  onClose: () => void;
};

const isCaretOnFirstLine = (element: HTMLTextAreaElement): boolean =>
  element.value.slice(0, element.selectionStart ?? 0).includes('\n') === false;

/** Shared chip shape for the property row, so every control reads as one family. */
const ChipButton = forwardRef<
  HTMLButtonElement,
  {
    icon: React.ReactNode;
    children: React.ReactNode;
    active?: boolean;
    disabled?: boolean;
  } & React.ComponentPropsWithoutRef<'button'>
>(function ChipButton({ icon, children, active, disabled, ...props }, ref) {
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      disabled={disabled}
      className={cn(
        'flex h-6 items-center gap-1 rounded-md border px-2 text-xs transition',
        'disabled:cursor-not-allowed disabled:opacity-50',
        active
          ? 'border-border/70 bg-muted-foreground/10 text-foreground'
          : 'border-border/60 text-muted-foreground hover:border-border hover:bg-muted-foreground/5 hover:text-foreground'
      )}
    >
      {icon}
      <span className="max-w-[10rem] truncate">{children}</span>
      <ChevronDown className="h-3 w-3 opacity-40" />
    </button>
  );
});

/**
 * Capture dialog for work that should not start now.
 *
 * Still nothing required: an empty title takes the body's first line, and
 * creating with both fields empty just closes. The property chips are all
 * defaulted — they exist so the details you already know can be recorded in one
 * pass instead of needing a second visit to the task page, which is a different
 * thing from making them mandatory. Keeping capture free of required fields is
 * what makes recording a task cheaper than starting a chat.
 *
 * Project uses the chat landing picker (`TaskProjectSelector` →
 * `UnifiedProjectSelectorView`) so long lists stay searchable. Deliberately
 * absent: anything that would name an agent.
 */
export function TaskQuickAddDialog({
  open,
  submitting = false,
  createMore,
  initialStatus = 'backlog',
  localProjects = [],
  agentOptions = [],
  repositories = [],
  latestMessageAtByRepo,
  onAddLocalProject,
  onConnectGitRepo,
  onCreateMoreChange,
  onSubmit,
  onClose,
}: TaskQuickAddDialogProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<TaskStatus>(initialStatus);
  const [project, setProject] = useState<ProjectRef | null>(null);
  const [priority, setPriority] = useState<TaskPriority | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [runAgent, setRunAgent] = useState<TaskAgentRef | null>(null);
  const [delegated, setDelegated] = useState(false);
  const priorityPresentation = getTaskPriorityPresentation(priority);
  const selectedAgentName = runAgent
    ? agentOptions.find((option) => option.agentConfigId === runAgent.agentConfigId)?.name
    : undefined;
  const titleRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open) {
      setTitle('');
      setBody('');
      setStatus(initialStatus);
      setProject(null);
      setPriority(null);
      setLabels([]);
      setRunAgent(null);
      setDelegated(false);
    }
  }, [initialStatus, open]);

  const isEmpty = title.trim().length === 0 && body.trim().length === 0;
  const statusPresentation = getTaskStatusPresentation(status);
  const showProjectPicker = localProjects.length > 0 || repositories.length > 0;

  const handleSubmit = () => {
    if (submitting) {
      return;
    }
    // Creating nothing is not an error and not an empty task: just close.
    if (isEmpty) {
      onClose();
      return;
    }
    onSubmit({ title, body, status, project, priority, labels, runAgent, delegated, createMore });
    if (createMore) {
      setTitle('');
      setBody('');
      titleRef.current?.focus();
    }
  };

  const submitOnModEnter = (event: React.KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      handleSubmit();
      return true;
    }
    return false;
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) {
          onClose();
        }
      }}
    >
      <DialogContent className={cn(TASKS_SURFACE_CLASS, 'max-w-2xl gap-0 p-0 sm:p-0')}>
        <div className="px-4 pt-3.5">
          <DialogTitle className="text-xs font-medium text-muted-foreground">
            {t('tasks.quickAdd.title', 'New task')}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('tasks.quickAdd.description', 'Record work to start later.')}
          </DialogDescription>
        </div>

        <div className="flex flex-col px-4 pt-1.5">
          {/*
            Inputs default to `bg-input rounded-md` — fine for form fields, but
            capture is meant to be borderless title/body on the dialog surface
            (Linear-style). In dark themes (Vesper) `--input` is a darker panel
            than `--background`, so the defaults read as nested gray slabs.
            Force transparent chrome; keep ring off so focus stays invisible.
          */}
          <Input
            ref={titleRef}
            value={title}
            disabled={submitting}
            placeholder={t('tasks.quickAdd.titlePlaceholder', 'Task title')}
            className="h-auto rounded-none border-none bg-transparent px-0 text-base font-medium text-foreground shadow-none placeholder:text-muted-foreground focus-visible:ring-0"
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (submitOnModEnter(event)) return;
              if (event.key === 'Enter' || event.key === 'ArrowDown') {
                event.preventDefault();
                bodyRef.current?.focus();
              }
            }}
          />
          <Textarea
            ref={bodyRef}
            value={body}
            disabled={submitting}
            rows={4}
            placeholder={t('tasks.quickAdd.bodyPlaceholder', 'Details (optional)')}
            className="min-h-[5rem] resize-none rounded-none border-none bg-transparent px-0 text-foreground shadow-none placeholder:text-muted-foreground focus-visible:ring-0"
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if (submitOnModEnter(event)) return;
              if (
                event.key === 'ArrowUp' &&
                event.currentTarget instanceof HTMLTextAreaElement &&
                isCaretOnFirstLine(event.currentTarget)
              ) {
                event.preventDefault();
                titleRef.current?.focus();
              }
            }}
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3 pt-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={submitting}>
              <ChipButton
                active
                disabled={submitting}
                icon={
                  <statusPresentation.Icon
                    className={cn('h-3.5 w-3.5', statusPresentation.className)}
                  />
                }
              >
                {t(statusPresentation.labelKey, statusPresentation.labelFallback)}
              </ChipButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className={tasksMenuClassName()}
              style={tasksMenuSurfaceStyle}
            >
              {TASK_STATUS_PRESENTATION.map((presentation) => (
                <DropdownMenuItem
                  key={presentation.status}
                  onSelect={() => setStatus(presentation.status)}
                >
                  <presentation.Icon className={cn('h-3.5 w-3.5', presentation.className)} />
                  {t(presentation.labelKey, presentation.labelFallback)}
                  {presentation.status === status ? (
                    <Check className="ml-auto h-3.5 w-3.5" />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={submitting}>
              <ChipButton
                active={priority !== null}
                disabled={submitting}
                icon={
                  <priorityPresentation.Icon
                    className={cn('h-3.5 w-3.5', priorityPresentation.className)}
                  />
                }
              >
                {t(priorityPresentation.labelKey, priorityPresentation.labelFallback)}
              </ChipButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className={tasksMenuClassName('w-44')}
              style={tasksMenuSurfaceStyle}
            >
              {TASK_PRIORITY_PRESENTATION.map((option) => (
                <DropdownMenuItem
                  key={option.priority}
                  onSelect={() => setPriority(option.priority)}
                >
                  <option.Icon className={cn('h-3.5 w-3.5', option.className)} />
                  {t(option.labelKey, option.labelFallback)}
                  {option.priority === priority ? <Check className="ml-auto h-3.5 w-3.5" /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={submitting}>
              <ChipButton
                active={labels.length > 0}
                disabled={submitting}
                icon={<Tag className="h-3.5 w-3.5" />}
              >
                {labels.length > 0 ? labels.join(', ') : t('tasks.properties.labels', 'Labels')}
              </ChipButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className={tasksMenuClassName('w-52')}
              style={tasksMenuSurfaceStyle}
            >
              {TASK_SUGGESTED_LABELS.map((label) => {
                const active = labels.includes(label);
                return (
                  <DropdownMenuItem
                    key={label}
                    // Multi-select: stay open so several can be set in one pass.
                    onSelect={(event) => {
                      event.preventDefault();
                      setLabels((previous) =>
                        active ? previous.filter((it) => it !== label) : [...previous, label]
                      );
                    }}
                  >
                    <span
                      style={taskLabelPillStyle(label)}
                      className="rounded border px-1.5 text-[10px] leading-4"
                    >
                      {label}
                    </span>
                    {active ? <Check className="ml-auto h-3.5 w-3.5" /> : null}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          {agentOptions.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild disabled={submitting}>
                <ChipButton
                  active={Boolean(runAgent)}
                  disabled={submitting}
                  icon={
                    delegated ? <Zap className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />
                  }
                >
                  {selectedAgentName ?? t('tasks.slots.chooseAgent', 'Choose agent')}
                </ChipButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className={tasksMenuClassName('w-64')}
                style={tasksMenuSurfaceStyle}
              >
                {agentOptions.map((option) => (
                  <DropdownMenuItem
                    key={option.agentConfigId}
                    onSelect={() =>
                      setRunAgent({
                        agentConfigId: option.agentConfigId as TaskAgentRef['agentConfigId'],
                      })
                    }
                  >
                    <Bot className="h-3.5 w-3.5" />
                    {option.name}
                    {runAgent?.agentConfigId === option.agentConfigId ? (
                      <Check className="ml-auto h-3.5 w-3.5" />
                    ) : null}
                  </DropdownMenuItem>
                ))}
                {runAgent ? (
                  <>
                    <DropdownMenuSeparator />
                    {/* The ONLY thing here that writes `agent`. Picking a runner
                       above stays `lastRunConfig`, so choosing who would run it
                       never by itself lets the scheduler start it. */}
                    <DropdownMenuItem
                      onSelect={(event) => {
                        event.preventDefault();
                        setDelegated((previous) => !previous);
                      }}
                    >
                      <Zap className="h-3.5 w-3.5" />
                      <span className="flex-1">
                        {t('tasks.autoRun.delegatedTitle', 'Run automatically')}
                      </span>
                      {delegated ? <Check className="h-3.5 w-3.5" /> : null}
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {showProjectPicker ? (
            <div className={cn(submitting && 'pointer-events-none opacity-50')}>
              <TaskProjectSelector
                value={project}
                onChange={setProject}
                localProjects={localProjects}
                repositories={repositories}
                latestMessageAtByRepo={latestMessageAtByRepo}
                onAddLocalProject={onAddLocalProject ?? (() => {})}
                onConnectGitRepo={onConnectGitRepo ?? (() => {})}
                contentSide="bottom"
              />
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between border-t px-4 py-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={createMore}
              disabled={submitting}
              onCheckedChange={(checked) => onCreateMoreChange(checked === true)}
            />
            {t('tasks.quickAdd.createMore', 'Create more')}
          </label>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="small" onClick={onClose} disabled={submitting}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button size="small" onClick={handleSubmit} disabled={submitting}>
              {t('tasks.quickAdd.create', 'Create')}
              <Kbd className="ml-1.5 hidden sm:inline-flex">⌘↵</Kbd>
            </Button>
          </div>
        </div>
        {/* Keep projectRefKey reachable for tests/stories that assert the
           selection identity without importing the helper themselves. */}
        {project ? <span className="sr-only" data-project-key={projectRefKey(project)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

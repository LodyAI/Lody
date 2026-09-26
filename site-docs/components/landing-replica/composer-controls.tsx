import type { ReactNode } from 'react';
import {
  Bot,
  Check,
  ChevronDown,
  Compass,
  Eye,
  FolderOpen,
  GitBranch,
  Github,
  Monitor,
  PenLine,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
} from 'lucide-react';
import { Button } from './button';
import { AgentIcon } from './icons';
import type { ReplicaAgent, ReplicaLocale } from './types';
import { cn } from './utils';

/* Resting triggers of the selectors in and around the composer. Sources:
   chat/unified-project-selector.tsx, chat/chat-landing-selectors.tsx,
   shared/workdir-mode-selector.tsx, sessions/desktop-run-config-menu.tsx and
   mobile/mobile-run-config-button.tsx. Menus never open on the landing, so only
   the closed trigger markup is carried. */

// ---- Top row: machine / project / branch + worktree ---------------------------

const CONTEXT_PILL_CLASS =
  'border-[0.5px] border-border bg-white shadow-[0px_0.5px_1px_1px_rgba(0,0,0,0.03)] dark:border-transparent dark:bg-foreground/[0.08] dark:shadow-none hover:bg-hover hover:text-foreground dark:hover:bg-foreground/[0.12]';

/** `DesktopMachineMenu` trigger. */
export function ReplicaMachineMenuTrigger({ label }: { label: string }) {
  return (
    <button
      type="button"
      aria-label="Machine"
      className={cn(
        'inline-flex h-6 min-w-0 select-none items-center gap-1.5 rounded-md px-2 text-[0.9em] font-normal leading-tight text-foreground/80 transition-colors [&_svg]:text-current [&_svg]:opacity-100',
        CONTEXT_PILL_CLASS
      )}
    >
      <Monitor className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="max-w-32 truncate">{label}</span>
    </button>
  );
}

/** `UnifiedProjectSelectorView` chip trigger. `label` is ignored for `none`. */
export function ReplicaProjectSelectorTrigger({
  label,
  kind,
  locale,
  avatarUrl,
}: {
  label: string;
  kind: 'local' | 'github' | 'none';
  locale: ReplicaLocale;
  /** GitHub owner avatar; falls back to the GitHub mark like the app on error. */
  avatarUrl?: string;
}) {
  const icon =
    kind === 'github' ? (
      avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          aria-hidden="true"
          className="h-4 w-4 shrink-0 rounded-sm object-cover"
        />
      ) : (
        <Github className="h-4 w-4 shrink-0 opacity-70" />
      )
    ) : (
      <FolderOpen className="h-4 w-4 shrink-0 opacity-70" />
    );
  return (
    <div className="group/project relative flex min-w-0 items-center">
      <button
        type="button"
        className={cn(
          'flex h-6 min-w-0 max-w-[18rem] items-center gap-1.5 rounded-md px-2 text-[0.9em] font-normal text-foreground/80 transition-colors [&_svg]:text-current [&_svg]:opacity-100',
          CONTEXT_PILL_CLASS
        )}
      >
        <span
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center',
            kind !== 'none' &&
              'transition-opacity group-hover/project:opacity-0 group-focus-within/project:opacity-0'
          )}
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-left">
          {kind === 'none' ? (locale === 'zh' ? '选择项目' : 'Select a project') : label}
        </span>
      </button>
    </div>
  );
}

/* Branch trigger (OptionSelector ghost button, md size) with the landing's
   class overrides, plus the Radix checkbox markup of `WorktreeCheckboxPill`. */
export function ReplicaBranchWorktreePill({
  branch,
  worktree,
  showWorktree,
  locale,
}: {
  branch: string | null;
  worktree: boolean;
  /** Local projects only; GitHub/chat contexts omit the toggle. */
  showWorktree: boolean;
  locale: ReplicaLocale;
}) {
  const state = worktree ? 'checked' : 'unchecked';
  return (
    <div className="flex h-6 min-w-0 max-w-full items-center overflow-hidden rounded-md bg-[hsl(var(--composer))] dark:bg-foreground/[0.08]">
      <span className="inline-flex min-w-0 items-center" data-demo="branch">
        <Button
          variant="ghost"
          className="h-6 w-auto select-none justify-between gap-1 rounded-md border-none bg-transparent px-1 text-sm font-medium text-foreground [&_span]:text-xs [&_span]:leading-tight"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <GitBranch className="h-4 w-4 shrink-0 opacity-70" />
            <span className="truncate font-medium">
              {branch ?? (locale === 'zh' ? '分支' : 'Branch')}
            </span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </span>
      {showWorktree ? (
        <>
          <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
          <span data-demo="workdir" className="inline-flex shrink-0">
            <label className="flex h-6 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-none bg-transparent px-2 text-xs font-normal text-foreground/80 transition-colors hover:bg-foreground/[0.06] hover:text-foreground">
              <button
                type="button"
                role="checkbox"
                aria-checked={worktree}
                aria-label="Use worktree"
                data-state={state}
                data-slot="checkbox"
                className="peer size-3 shrink-0 rounded-[3px] border border-transparent bg-muted-foreground/15 shadow-none outline-hidden transition-shadow dark:bg-muted-foreground/15 data-[state=checked]:border-transparent data-[state=checked]:bg-muted-foreground/25 data-[state=checked]:text-foreground/80 dark:data-[state=checked]:bg-muted-foreground/25 [&_svg]:size-3"
              >
                {worktree ? (
                  <span
                    data-state={state}
                    data-slot="checkbox-indicator"
                    className="flex items-center justify-center text-current transition-none"
                  >
                    <Check />
                  </span>
                ) : null}
              </button>
              <span>worktree</span>
            </label>
          </span>
        </>
      ) : null}
    </div>
  );
}

// ---- Footer: run config + permission ------------------------------------------

/** Hide face labels when the composer footer slot is this narrow. */
const FACE_LABEL_CLASS = '@max-[280px]/composer-face:hidden';

const TRIGGER_CLASS =
  'inline-flex h-7 min-w-0 select-none items-center gap-1.5 rounded-[4px] px-2 text-[0.9em] leading-tight @max-[280px]/composer-face:w-7 @max-[280px]/composer-face:shrink-0 @max-[280px]/composer-face:justify-center @max-[280px]/composer-face:gap-0 @max-[280px]/composer-face:px-0 text-muted-foreground transition-colors hover:bg-hover hover:text-foreground disabled:cursor-default disabled:opacity-70';

/** `DesktopRunConfigMenu` trigger: agent icon + model · reasoning. `agent: null`
    renders the generic Bot the app shows for an unresolved agent config. */
export function ReplicaRunConfigTrigger({
  agent,
  modelLabel,
  thinkLabel,
}: {
  agent: ReplicaAgent | null;
  modelLabel: string;
  thinkLabel?: string;
}) {
  return (
    <button type="button" className={TRIGGER_CLASS} aria-label="Run configuration">
      {agent ? (
        <AgentIcon agent={agent} className="h-4 w-4 shrink-0" />
      ) : (
        <Bot className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
      )}
      <span
        className={cn(
          'block min-w-0 max-w-40 truncate text-left [direction:rtl]',
          FACE_LABEL_CLASS
        )}
      >
        <span dir="ltr">{modelLabel}</span>
      </span>
      {thinkLabel ? (
        <>
          <span
            aria-hidden="true"
            className={cn('shrink-0 select-none text-muted-foreground/60', FACE_LABEL_CLASS)}
          >
            ·
          </span>
          <span className={cn('shrink-0', FACE_LABEL_CLASS)}>{thinkLabel}</span>
        </>
      ) : null}
    </button>
  );
}

const MODE_ICON_CLASS = 'h-3.5 w-3.5';

/** Permission-mode glyph (app `getModeIcon` from chat-landing-selectors). */
export function getModeIcon(modeId: string | null): ReactNode {
  switch (modeId) {
    case 'plan':
      return <Compass className={MODE_ICON_CLASS} strokeWidth={1.5} />;
    case 'acceptEdits':
      return <PenLine className={MODE_ICON_CLASS} strokeWidth={1.5} />;
    case 'dontAsk':
      return <ShieldOff className={MODE_ICON_CLASS} strokeWidth={1.5} />;
    case 'read-only':
      return <Eye className={MODE_ICON_CLASS} strokeWidth={1.5} />;
    default:
      return <ShieldCheck className={MODE_ICON_CLASS} strokeWidth={1.5} />;
  }
}

// Mode ids the app flags with the amber shield (classifyPermissionModeFace).
const WARNING_MODE_IDS = new Set([
  'agent-full-access',
  'danger-full-access',
  'dontAsk',
  'bypassPermissions',
  'yolo',
  'always-approve',
]);

/** `DesktopPermissionModeButton` trigger. The landing's modes resolve to `default`. */
export function ReplicaPermissionModeTrigger({
  label,
  modeId = 'default',
}: {
  label: string;
  modeId?: string;
}) {
  return (
    <button type="button" className={TRIGGER_CLASS} aria-label="Permission">
      <span className="flex h-4 w-4 shrink-0 items-center justify-center [&_svg]:h-4 [&_svg]:w-4 [&_svg]:stroke-[1.5]">
        {WARNING_MODE_IDS.has(modeId) ? (
          <ShieldAlert className="h-4 w-4 shrink-0 text-status-warning" strokeWidth={1.5} />
        ) : (
          getModeIcon(modeId)
        )}
      </span>
      <span className={cn('min-w-0 max-w-36 truncate', FACE_LABEL_CLASS)}>{label}</span>
    </button>
  );
}

/** `MobileRunConfigButton` face (default permission mode, no Plan/Fast). */
export function ReplicaMobileRunConfigTrigger({
  agent,
  modelLabel,
  thinkLabel,
}: {
  agent: ReplicaAgent;
  modelLabel: string;
  thinkLabel?: string;
}) {
  return (
    <button
      type="button"
      aria-label="Run configuration"
      className="inline-flex h-8 min-w-0 max-w-full select-none flex-nowrap items-center gap-1.5 overflow-hidden rounded-md px-1.5 text-sm text-foreground transition-colors hover:bg-muted/50 active:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="flex min-w-0 items-center gap-1 overflow-hidden">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center [&>*]:h-4 [&>*]:w-4">
          <AgentIcon agent={agent} className="h-4 w-4" />
        </span>
        <span className="min-w-0 truncate text-left [direction:rtl]">
          <span dir="ltr">{modelLabel}</span>
        </span>
      </span>
      {thinkLabel ? (
        <>
          <span aria-hidden="true" className="shrink-0 select-none text-muted-foreground/70">
            ·
          </span>
          <span className="shrink-0 whitespace-nowrap">{thinkLabel}</span>
        </>
      ) : null}
    </button>
  );
}

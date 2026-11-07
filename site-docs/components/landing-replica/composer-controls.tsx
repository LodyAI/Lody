import * as stylex from '@stylexjs/stylex';
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
const composerControlsComposition = stylex.create({
  part1: {
    display: 'inline-flex',
    height: 'calc(var(--spacing) * 6)',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'border-radius': 'var(--radius-md)',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'font-size': '0.9em',
    'line-height': 'var(--leading-tight)',
    'font-weight': 'var(--font-weight-normal)',
    color: 'color-mix(in oklab, hsl(var(--foreground)) 80%, transparent)',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    '-webkit-user-select': 'none',
    'user-select': 'none',
    ':is(*) svg': {
      color: 'currentcolor',
      opacity: '100%',
    },
  },
  part2: {
    'border-style': 'solid',
    'border-width': '0.5px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'var(--color-white)',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0px 0.5px 1px 1px rgba(0,0,0,0.03)',
    '@media (hover: hover)': {
      ':is(*):hover': {
        'background-color': 'hsl(var(--hover))',
        color: 'hsl(var(--foreground))',
      },
      ':is(*):where(.dark, .dark *):hover': {
        'background-color': 'color-mix(in oklab, hsl(var(--foreground)) 12%, transparent)',
      },
    },
    ':is(*):where(.dark, .dark *)': {
      'border-color': 'transparent',
      'background-color': 'color-mix(in oklab, hsl(var(--foreground)) 8%, transparent)',
      'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000',
    },
  },
  part3: {
    display: 'flex',
    height: 'calc(var(--spacing) * 6)',
    'max-width': '18rem',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'border-radius': 'var(--radius-md)',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'font-size': '0.9em',
    'font-weight': 'var(--font-weight-normal)',
    color: 'color-mix(in oklab, hsl(var(--foreground)) 80%, transparent)',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    ':is(*) svg': {
      color: 'currentcolor',
      opacity: '100%',
    },
  },
  part4: {
    display: 'flex',
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
  },
  part5: {
    'transition-property': 'opacity',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    ':is(*):is(:where(.group\\/project):focus-within *)': {
      opacity: '0%',
    },
    '@media (hover: hover)': {
      ':is(*):is(:where(.group\\/project):hover *)': {
        opacity: '0%',
      },
    },
  },
  part6: {
    display: 'inline-flex',
    height: 'calc(var(--spacing) * 7)',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'border-radius': '4px',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'font-size': '0.9em',
    'line-height': 'var(--leading-tight)',
    color: 'hsl(var(--muted-foreground))',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    '-webkit-user-select': 'none',
    'user-select': 'none',
    '@media (hover: hover)': {
      ':is(*):hover': {
        'background-color': 'hsl(var(--hover))',
        color: 'hsl(var(--foreground))',
      },
    },
    ':is(*):disabled': {
      cursor: 'default',
      opacity: '70%',
    },
    '@container composer-face (width < 280px)': {
      width: 'calc(var(--spacing) * 7)',
      'flex-shrink': '0',
      'justify-content': 'center',
      gap: '0px',
      'padding-inline': '0px',
    },
  },
  part7: {
    display: 'block',
    'max-width': 'calc(var(--spacing) * 40)',
    'min-width': '0px',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'text-align': 'left',
    direction: 'rtl',
  },
  part8: {
    '@container composer-face (width < 280px)': {
      display: 'none',
    },
  },
  part9: {
    'flex-shrink': '0',
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 60%, transparent)',
    '-webkit-user-select': 'none',
    'user-select': 'none',
  },
  part10: {
    'flex-shrink': '0',
  },
  part11: {
    'max-width': 'calc(var(--spacing) * 36)',
    'min-width': '0px',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  },
});

const composerControlsStylesNative = stylex.create({
  row: {
    display: 'flex',
    height: 'calc(var(--spacing) * 6)',
    'flex-shrink': '0',
    cursor: 'pointer',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'border-radius': '0',
    'background-color': 'transparent',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-normal)',
    color: 'color-mix(in oklab, hsl(var(--foreground)) 80%, transparent)',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    '-webkit-user-select': 'none',
    'user-select': 'none',
    '@media (hover: hover)': {
      ':is(*):hover': {
        'background-color': 'color-mix(in oklab, hsl(var(--foreground)) 6%, transparent)',
        color: 'hsl(var(--foreground))',
      },
    },
  },
  row2: {
    display: 'inline-flex',
    height: 'calc(var(--spacing) * 8)',
    'max-width': '100%',
    'min-width': '0px',
    'flex-wrap': 'nowrap',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    overflow: 'hidden',
    'border-radius': 'var(--radius-md)',
    'padding-inline': 'calc(var(--spacing) * 1.5)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    color: 'hsl(var(--foreground))',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    '-webkit-user-select': 'none',
    'user-select': 'none',
    '@media (hover: hover)': {
      ':is(*):hover': {
        'background-color': 'color-mix(in oklab, hsl(var(--muted)) 50%, transparent)',
      },
    },
    ':is(*):active': {
      'background-color': 'color-mix(in oklab, hsl(var(--muted)) 60%, transparent)',
    },
    ':is(*):disabled': {
      cursor: 'not-allowed',
      opacity: '60%',
    },
  },
});

const composerControlsStyles = stylex.create({
  glyph: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    'flex-shrink': '0',
  },
  label: {
    'max-width': 'calc(var(--spacing) * 32)',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  },
  frame: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    'flex-shrink': '0',
    'border-radius': 'var(--radius-sm)',
    'object-fit': 'cover',
  },
  glyph2: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    'flex-shrink': '0',
    opacity: '70%',
  },
  row: {
    position: 'relative',
    display: 'flex',
    'min-width': '0px',
    'align-items': 'center',
  },
  label2: {
    'min-width': '0px',
    flex: '1',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'text-align': 'left',
  },
  row2: {
    display: 'flex',
    height: 'calc(var(--spacing) * 6)',
    'max-width': '100%',
    'min-width': '0px',
    'align-items': 'center',
    overflow: 'hidden',
    'border-radius': 'var(--radius-md)',
    'background-color': 'hsl(var(--composer))',
    ':is(*):where(.dark, .dark *)': {
      'background-color': 'color-mix(in oklab, hsl(var(--foreground)) 8%, transparent)',
    },
  },
  row3: {
    display: 'inline-flex',
    'min-width': '0px',
    'align-items': 'center',
  },
  surface: {
    height: 'calc(var(--spacing) * 4)',
    width: '1px',
    'flex-shrink': '0',
    'background-color': 'hsl(var(--border))',
  },
  row4: {
    display: 'inline-flex',
    'flex-shrink': '0',
  },
  surface2: {
    width: 'calc(var(--spacing) * 3)',
    height: 'calc(var(--spacing) * 3)',
    'flex-shrink': '0',
    'border-radius': '3px',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'transparent',
    'background-color': 'color-mix(in oklab, hsl(var(--muted-foreground)) 15%, transparent)',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000',
    'outline-style': 'none',
    'transition-property': 'box-shadow',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    ':is(*)[data-state="checked"]': {
      'border-color': 'transparent',
      'background-color': 'color-mix(in oklab, hsl(var(--muted-foreground)) 25%, transparent)',
      color: 'color-mix(in oklab, hsl(var(--foreground)) 80%, transparent)',
    },
    ':is(*):where(.dark, .dark *)': {
      'background-color': 'color-mix(in oklab, hsl(var(--muted-foreground)) 15%, transparent)',
    },
    ':is(*):where(.dark, .dark *)[data-state="checked"]': {
      'background-color': 'color-mix(in oklab, hsl(var(--muted-foreground)) 25%, transparent)',
    },
    ':is(*) svg': {
      width: 'calc(var(--spacing) * 3)',
      height: 'calc(var(--spacing) * 3)',
    },
  },
  row5: {
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'center',
    color: 'currentcolor',
    'transition-property': 'none',
  },
  row6: {
    display: 'flex',
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
    ':is(*) svg': {
      height: 'calc(var(--spacing) * 4)',
      width: 'calc(var(--spacing) * 4)',
      'stroke-width': '1.5',
    },
  },
  glyph3: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    'flex-shrink': '0',
    color: 'hsl(var(--status-warning))',
  },
  row7: {
    display: 'flex',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'var(--spacing)',
    overflow: 'hidden',
  },
  row8: {
    display: 'flex',
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
    ':is(*) > *': {
      height: 'calc(var(--spacing) * 4)',
      width: 'calc(var(--spacing) * 4)',
    },
  },
  label3: {
    'min-width': '0px',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'text-align': 'left',
    direction: 'rtl',
  },
  label4: {
    'flex-shrink': '0',
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 70%, transparent)',
    '-webkit-user-select': 'none',
    'user-select': 'none',
  },
  label5: {
    'flex-shrink': '0',
    'white-space': 'nowrap',
  },
});

const buttonChildStyles = stylex.create({
  label: {
    display: 'flex',
    'min-width': '0px',
    flex: '1',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
  },
  icon: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    'flex-shrink': '0',
    opacity: '70%',
  },
  label2: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-weight': 'var(--font-weight-medium)',
  },
});

const buttonStyles = stylex.create({
  chevron: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
    opacity: 0.6,
  },
  agent: { height: 'calc(var(--spacing) * 4)', width: 'calc(var(--spacing) * 4)' },
  agentFixed: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    flexShrink: 0,
  },
  branch: {
    height: 'calc(var(--spacing) * 6)',
    width: 'auto',
    userSelect: 'none',
    justifyContent: 'space-between',
    gap: 'calc(var(--spacing) * 1)',
    borderRadius: 'var(--radius-md)',
    borderStyle: 'none',
    backgroundColor: 'transparent',
    paddingInline: 'calc(var(--spacing) * 1)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: 'var(--font-weight-medium)',
    color: 'hsl(var(--foreground))',
  },
});

/* Resting triggers of the selectors in and around the composer. Sources:
   chat/unified-project-selector.tsx, chat/chat-landing-selectors.tsx,
   shared/workdir-mode-selector.tsx, sessions/desktop-run-config-menu.tsx and
   mobile/mobile-run-config-button.tsx. Menus never open on the landing, so only
   the closed trigger markup is carried. */

// ---- Top row: machine / project / branch + worktree ---------------------------

const contextPillStyle = composerControlsComposition.part2;

/** `DesktopMachineMenu` trigger. */
export function ReplicaMachineMenuTrigger({ label }: { label: string }) {
  return (
    <button
      type="button"
      aria-label="Machine"
      {...stylex.props([composerControlsComposition.part1, contextPillStyle])}
    >
      <Monitor {...stylex.props(composerControlsStyles.glyph)} aria-hidden="true" />
      <span {...stylex.props(composerControlsStyles.label)}>{label}</span>
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
          {...stylex.props(composerControlsStyles.frame)}
        />
      ) : (
        <Github {...stylex.props(composerControlsStyles.glyph2)} />
      )
    ) : (
      <FolderOpen {...stylex.props(composerControlsStyles.glyph2)} />
    );
  return (
    <div
      className={[stylex.props(composerControlsStyles.row).className, 'group/project']
        .filter(Boolean)
        .join(' ')}
    >
      <button
        type="button"
        {...stylex.props([composerControlsComposition.part3, contextPillStyle])}
      >
        <span
          {...stylex.props([
            composerControlsComposition.part4,
            kind !== 'none' && composerControlsComposition.part5,
          ])}
        >
          {icon}
        </span>
        <span {...stylex.props(composerControlsStyles.label2)}>
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
    <div {...stylex.props(composerControlsStyles.row2)}>
      <span {...stylex.props(composerControlsStyles.row3)} data-demo="branch">
        <Button variant="ghost" xstyle={buttonStyles.branch} compactLabel>
          <span {...stylex.props(buttonChildStyles.label)}>
            <GitBranch {...stylex.props(buttonChildStyles.icon)} />
            <span {...stylex.props(buttonChildStyles.label2)}>
              {branch ?? (locale === 'zh' ? '分支' : 'Branch')}
            </span>
          </span>
          <ChevronDown data-replica-sized {...stylex.props(buttonStyles.chevron)} />
        </Button>
      </span>
      {showWorktree ? (
        <>
          <span aria-hidden="true" {...stylex.props(composerControlsStyles.surface)} />
          <span data-demo="workdir" {...stylex.props(composerControlsStyles.row4)}>
            <label {...stylex.props(composerControlsStylesNative.row)}>
              <button
                type="button"
                role="checkbox"
                aria-checked={worktree}
                aria-label="Use worktree"
                data-state={state}
                data-slot="checkbox"
                className={[stylex.props(composerControlsStyles.surface2).className, 'peer']
                  .filter(Boolean)
                  .join(' ')}
              >
                {worktree ? (
                  <span
                    data-state={state}
                    data-slot="checkbox-indicator"
                    {...stylex.props(composerControlsStyles.row5)}
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
const faceLabelStyle = composerControlsComposition.part8;

const selectorTriggerStyle = composerControlsComposition.part6;

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
    <button type="button" {...stylex.props(selectorTriggerStyle)} aria-label="Run configuration">
      {agent ? (
        <AgentIcon agent={agent} xstyle={buttonStyles.agentFixed} />
      ) : (
        <Bot {...stylex.props(composerControlsStyles.glyph)} strokeWidth={1.5} aria-hidden="true" />
      )}
      <span {...stylex.props([composerControlsComposition.part7, faceLabelStyle])}>
        <span dir="ltr">{modelLabel}</span>
      </span>
      {thinkLabel ? (
        <>
          <span
            aria-hidden="true"
            {...stylex.props([composerControlsComposition.part9, faceLabelStyle])}
          >
            ·
          </span>
          <span {...stylex.props([composerControlsComposition.part10, faceLabelStyle])}>
            {thinkLabel}
          </span>
        </>
      ) : null}
    </button>
  );
}

const modeIconStyle = stylex.create({
  glyph: { height: 'calc(var(--spacing) * 3.5)', width: 'calc(var(--spacing) * 3.5)' },
});

/** Permission-mode glyph (app `getModeIcon` from chat-landing-selectors). */
export function getModeIcon(modeId: string | null): ReactNode {
  switch (modeId) {
    case 'plan':
      return <Compass {...stylex.props(modeIconStyle.glyph)} strokeWidth={1.5} />;
    case 'acceptEdits':
      return <PenLine {...stylex.props(modeIconStyle.glyph)} strokeWidth={1.5} />;
    case 'dontAsk':
      return <ShieldOff {...stylex.props(modeIconStyle.glyph)} strokeWidth={1.5} />;
    case 'read-only':
      return <Eye {...stylex.props(modeIconStyle.glyph)} strokeWidth={1.5} />;
    default:
      return <ShieldCheck {...stylex.props(modeIconStyle.glyph)} strokeWidth={1.5} />;
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
    <button type="button" {...stylex.props(selectorTriggerStyle)} aria-label="Permission">
      <span {...stylex.props(composerControlsStyles.row6)}>
        {WARNING_MODE_IDS.has(modeId) ? (
          <ShieldAlert {...stylex.props(composerControlsStyles.glyph3)} strokeWidth={1.5} />
        ) : (
          getModeIcon(modeId)
        )}
      </span>
      <span {...stylex.props([composerControlsComposition.part11, faceLabelStyle])}>{label}</span>
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
      {...stylex.props(composerControlsStylesNative.row2)}
    >
      <span {...stylex.props(composerControlsStyles.row7)}>
        <span {...stylex.props(composerControlsStyles.row8)}>
          <AgentIcon agent={agent} xstyle={buttonStyles.agent} />
        </span>
        <span {...stylex.props(composerControlsStyles.label3)}>
          <span dir="ltr">{modelLabel}</span>
        </span>
      </span>
      {thinkLabel ? (
        <>
          <span aria-hidden="true" {...stylex.props(composerControlsStyles.label4)}>
            ·
          </span>
          <span {...stylex.props(composerControlsStyles.label5)}>{thinkLabel}</span>
        </>
      ) : null}
    </button>
  );
}

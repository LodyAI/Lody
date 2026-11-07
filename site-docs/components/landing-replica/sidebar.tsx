import * as stylex from '@stylexjs/stylex';
import { useId, type ReactNode } from 'react';
import {
  Archive,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Folder,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Hand,
  Loader2,
  Search,
  Settings,
  SquarePen,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Button } from './button';
import type { ReplicaLocale, ReplicaPrStatus, ReplicaSessionRow } from './types';
import { clsx } from 'clsx';
const sidebarBehavior = stylex.create({
  groupHeader: {
    position: 'relative',
    display: 'flex',
    height: 'calc(var(--spacing) * 7)',
    width: '100%',
    'min-width': '0px',
    flex: '1',
    cursor: 'pointer',
    'align-items': 'center',
    gap: 'var(--spacing)',
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'transparent',
    'background-color': 'transparent',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'text-align': 'left',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    '-webkit-user-select': 'none',
    'user-select': 'none',
  },
  repoHeader: {
    'font-size': '0.9em',
    'font-weight': 'var(--font-weight-normal)',
    color: 'hsl(var(--sidebar-foreground))',
    ':is(*):where(.dark, .dark *)': {
      color: 'color-mix(in oklab, hsl(var(--sidebar-foreground)) 75%, transparent)',
    },
  },
  chatHeader: {
    'font-size': '0.9em',
    'font-weight': 'var(--font-weight-medium)',
    color: 'hsl(var(--sidebar-foreground-muted))',
  },
  navRow: {
    display: 'flex',
    width: '100%',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'border-radius': 'var(--radius-lg)',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'calc(var(--spacing) * 1.5)',
    'text-align': 'left',
    'font-size': '0.9em',
    'outline-style': 'none',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    '-webkit-user-select': 'none',
    'user-select': 'none',
  },
  activeNav: {
    'background-color': 'hsl(var(--sidebar-selection))',
    color: 'hsl(var(--sidebar-selection-foreground))',
  },
  idleNav: {
    color: 'hsl(var(--sidebar-foreground))',
    ':is(*):where(.dark, .dark *)': {
      color: 'color-mix(in oklab, hsl(var(--sidebar-foreground)) 75%, transparent)',
    },
  },
});

const sidebarStates = stylex.create({
  prGlyph: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    'flex-shrink': '0',
  },
  ciGlyph: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    'flex-shrink': '0',
  },
  mergedOffset: {
    translate: '1px 0',
  },
  sessionRow: {
    position: 'relative',
    width: '100%',
    cursor: 'pointer',
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'transparent',
    'background-color': 'transparent',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'var(--spacing)',
    'text-align': 'left',
  },
  selectedRow: {
    'background-color': 'hsl(var(--sidebar-selection))',
    color: 'hsl(var(--sidebar-selection-foreground))',
  },
  sessionTitle: {
    display: 'flex',
    'min-width': '0px',
    flex: '1',
    'align-items': 'center',
    gap: 'var(--spacing)',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': '0.9em',
  },
  selectedInk: {
    color: 'hsl(var(--sidebar-selection-foreground))',
  },
  idleInk: {
    color: 'hsl(var(--sidebar-foreground))',
  },
  compactGroup: {
    ':is(*) > :not(:last-child)': {
      'margin-block-start': 0,
      'margin-block-end': 'calc(var(--spacing) * 0.5)',
    },
  },
  projectRow: {
    width: '100%',
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'transparent',
    'background-color': 'transparent',
    'padding-block': 'calc(var(--spacing) * 1.5)',
    'padding-right': 'calc(var(--spacing) * 3)',
    'padding-left': 'calc(var(--spacing) * 2)',
    'text-align': 'left',
  },
  sections: {
    ':is(*) > :not(:last-child)': {
      'margin-block-start': 0,
      'margin-block-end': 'calc(var(--spacing) * 3)',
    },
  },
  groups: {
    ':is(*) > :not(:last-child)': {
      'margin-block-start': 0,
      'margin-block-end': 'calc(var(--spacing) * 2)',
    },
  },
  projects: {
    ':is(*) > :not(:last-child)': {
      'margin-block-start': 0,
      'margin-block-end': 'calc(var(--spacing) * 1)',
    },
  },
});

const sidebarStyles = stylex.create({
  glyph: {
    width: '100%',
    height: '100%',
  },
  glyph2: {
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 3)',
    color: 'hsl(var(--status-warning))',
  },
  surface: {
    height: 'calc(var(--spacing) * 2)',
    width: 'calc(var(--spacing) * 2)',
    'border-radius': 'calc(infinity * 1px)',
    'background-color': 'hsl(var(--primary))',
  },
  row: {
    display: 'flex',
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
  },
  row2: {
    'pointer-events': 'none',
    position: 'relative',
    display: 'flex',
    height: 'calc(var(--spacing) * 5)',
    'min-width': 'calc(var(--spacing) * 5)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
  },
  row3: {
    display: 'flex',
  },
  row4: {
    display: 'inline-flex',
    height: 'calc(var(--spacing) * 5)',
    'flex-shrink': '0',
    'align-items': 'center',
    'border-radius': 'calc(infinity * 1px)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--status-success)) 45%, transparent)',
    'background-color': 'color-mix(in oklab, hsl(var(--status-success)) 6%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 1.5)',
    'font-size': '10px',
    'line-height': '1',
    'font-weight': 'var(--font-weight-medium)',
    'letter-spacing': '0.01em',
    color: 'hsl(var(--status-success))',
  },
  row5: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
  },
  row6: {
    display: 'inline-flex',
    'align-items': 'center',
    'justify-content': 'flex-end',
    gap: 'var(--spacing)',
    'font-size': '0.8em',
    color: 'hsl(var(--muted-foreground))',
  },
  label: {
    'font-variant-numeric': '   tabular-nums ',
    '-webkit-user-select': 'none',
    'user-select': 'none',
  },
  row7: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'font-size': '0.75em',
    color: 'color-mix(in oklab, hsl(var(--sidebar-foreground-muted)) 80%, transparent)',
    'font-variant-numeric': '   tabular-nums ',
    '-webkit-user-select': 'none',
    'user-select': 'none',
  },
  row8: {
    display: 'flex',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
  },
  row9: {
    position: 'relative',
    display: 'flex',
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
  },
  label2: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-weight': 'var(--font-weight-normal)',
  },
  stack: {
    'margin-bottom': 'calc(var(--spacing) * 3)',
    display: 'flex',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 0.5)',
    ':is(*):last-child': {
      'margin-bottom': '0px',
    },
  },
  row10: {
    display: 'flex',
    height: 'calc(var(--spacing) * 7)',
    'align-items': 'center',
  },
  row11: {
    position: 'relative',
    display: 'flex',
    height: 'calc(var(--spacing) * 5)',
    width: 'calc(var(--spacing) * 5)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
  },
  overlay: {
    position: 'absolute',
    top: 'calc(1 / 2 * 100%)',
    left: '0px',
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    translate: '0 calc(calc(1 / 2 * 100%) * -1)',
    'border-radius': 'var(--radius-sm)',
    'object-fit': 'cover',
    opacity: '80%',
  },
  label3: {
    'min-width': '0px',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'text-align': 'left',
  },
  label4: {
    flex: '1',
  },
  stack2: {
    display: 'flex',
    'flex-direction': 'column',
    gap: '1px',
  },
  row12: {
    display: 'flex',
    'align-items': 'center',
  },
  row13: {
    position: 'relative',
    display: 'flex',
    width: '100%',
    'min-width': '0px',
    flex: '1',
    cursor: 'pointer',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'transparent',
    'background-color': 'transparent',
    'padding-block': 'var(--spacing)',
    'padding-right': 'calc(var(--spacing) * 3)',
    'padding-left': 'calc(var(--spacing) * 2)',
    'text-align': 'left',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    color: 'color-mix(in oklab, hsl(var(--sidebar-foreground-muted)) 65%, transparent)',
    '-webkit-user-select': 'none',
    'user-select': 'none',
  },
  glyph3: {
    position: 'absolute',
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    color: 'currentcolor',
    opacity: '80%',
  },
  label5: {
    'min-width': '0px',
    flex: '1',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'text-align': 'left',
  },
  stack3: {
    display: 'flex',
    'flex-direction': 'column',
    gap: 'var(--spacing)',
  },
  row14: {
    display: 'flex',
    'align-items': 'flex-start',
    gap: 'calc(var(--spacing) * 2)',
  },
  row15: {
    'margin-top': 'calc(var(--spacing) * 0.5)',
    display: 'flex',
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    'align-items': 'center',
    'justify-content': 'center',
  },
  section: {
    'min-width': '0px',
    flex: '1',
  },
  row16: {
    display: 'flex',
    'min-width': '0px',
    'align-items': 'flex-start',
    gap: 'calc(var(--spacing) * 3)',
  },
  caption: {
    'min-width': '0px',
    flex: '1',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    color: 'currentcolor',
  },
  label6: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  },
  label7: {
    'margin-left': 'auto',
    'flex-shrink': '0',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground))',
    'font-variant-numeric': '   tabular-nums ',
    '-webkit-user-select': 'none',
    'user-select': 'none',
  },
  row17: {
    position: 'relative',
    display: 'flex',
    width: '100%',
    'align-items': 'center',
  },
  row18: {
    display: 'flex',
    height: 'calc(var(--spacing) * 5)',
    width: 'calc(var(--spacing) * 5)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
    color: 'currentcolor',
  },
  row19: {
    display: 'flex',
    height: 'calc(var(--spacing) * 5)',
    width: 'calc(var(--spacing) * 5)',
    'flex-shrink': '0',
    cursor: 'default',
    'align-items': 'center',
    'justify-content': 'center',
    'border-radius': 'var(--radius-md)',
    color: 'color-mix(in oklab, hsl(var(--sidebar-foreground-muted)) 40%, transparent)',
    'outline-style': 'none',
  },
  surface2: {
    'min-height': '0px',
    'flex-shrink': '0',
    'border-right-style': 'solid',
    'border-right-width': '1px',
    'border-color': 'hsl(var(--sidebar-border))',
    'background-color': 'hsl(var(--sidebar-background))',
  },
  frame: {
    position: 'relative',
    height: '100%',
    color: 'hsl(var(--sidebar-foreground))',
    '-webkit-user-select': 'none',
    'user-select': 'none',
  },
  stack4: {
    position: 'relative',
    display: 'flex',
    height: '100%',
    'flex-direction': 'column',
    overflow: 'hidden',
  },
  row20: {
    position: 'relative',
    display: 'flex',
    height: 'calc(var(--spacing) * 11)',
    'align-items': 'center',
    'justify-content': 'space-between',
    gap: 'calc(var(--spacing) * 2)',
    'padding-inline': 'calc(var(--spacing) * 1.5)',
  },
  label8: {
    'padding-inline': 'calc(var(--spacing) * 2)',
    'font-size': '18px',
    'line-height': '1',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': '-0.03em',
    color: 'hsl(var(--sidebar-foreground))',
    '-webkit-user-select': 'none',
    'user-select': 'none',
  },
  row21: {
    'margin-left': 'auto',
    display: 'flex',
    'flex-shrink': '0',
    'align-items': 'center',
  },
  glyph4: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
  },
  stack5: {
    display: 'flex',
    'flex-direction': 'column',
    gap: '1px',
    'padding-inline': 'calc(var(--spacing) * 1.5)',
  },
  glyph5: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
  },
  frame2: {
    'margin-top': 'calc(var(--spacing) * 2)',
    'min-height': '0px',
    flex: '1',
    overflow: 'hidden',
  },
  section2: {
    'padding-inline': 'calc(var(--spacing) * 1.5)',
    'padding-bottom': 'calc(var(--spacing) * 3)',
  },
  section3: {
    position: 'relative',
  },
  section4: {
    'padding-top': 'var(--spacing)',
    'padding-bottom': 'var(--spacing)',
  },
  row22: {
    display: 'flex',
    height: 'calc(var(--spacing) * 7)',
    'align-items': 'center',
    gap: 'var(--spacing)',
    'border-radius': 'var(--radius-md)',
    'padding-right': 'calc(var(--spacing) * 2)',
  },
  row23: {
    position: 'relative',
    display: 'flex',
    height: 'calc(var(--spacing) * 7)',
    'min-width': '0px',
    flex: '1',
    'align-items': 'center',
    gap: 'var(--spacing)',
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'transparent',
    'background-color': 'transparent',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'text-align': 'left',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    color: 'color-mix(in oklab, hsl(var(--sidebar-foreground-muted)) 65%, transparent)',
    '-webkit-user-select': 'none',
    'user-select': 'none',
  },
  label9: {
    'min-width': '0px',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  },
  stack6: {
    display: 'flex',
    'flex-direction': 'column',
  },
  caption2: {
    'padding-inline': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    color: 'color-mix(in oklab, hsl(var(--sidebar-foreground-muted)) 65%, transparent)',
  },
  frame3: {
    'margin-bottom': 'calc(var(--spacing) * 3)',
    width: '100%',
    ':is(*):last-child': {
      'margin-bottom': '0px',
    },
  },
  row24: {
    display: 'flex',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'space-between',
    'border-top-style': 'solid',
    'border-top-width': '0.5px',
    'border-color': 'hsl(var(--sidebar-border))',
    'padding-inline': 'calc(var(--spacing) * 1.5)',
    'padding-block': 'var(--spacing)',
  },
  row25: {
    display: 'flex',
    height: 'calc(var(--spacing) * 8)',
    width: '100%',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'border-radius': 'var(--radius-lg)',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'calc(var(--spacing) * 1.5)',
    'text-align': 'left',
    'font-size': '0.9em',
    color: 'hsl(var(--sidebar-foreground))',
    '-webkit-user-select': 'none',
    'user-select': 'none',
    ':is(*):where(.dark, .dark *)': {
      color: 'color-mix(in oklab, hsl(var(--sidebar-foreground)) 75%, transparent)',
    },
  },
  row26: {
    position: 'relative',
    display: 'flex',
    height: 'calc(var(--spacing) * 5)',
    width: 'calc(var(--spacing) * 5)',
    'flex-shrink': '0',
    overflow: 'hidden',
    'border-radius': 'calc(infinity * 1px)',
    'font-size': '10px',
  },
  frame4: {
    'aspect-ratio': '1 / 1',
    width: '100%',
    height: '100%',
  },
  row27: {
    display: 'flex',
    'min-width': '0px',
    flex: '1',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
  },
  label10: {
    'min-width': '0px',
    flex: '1',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-weight': 'var(--font-weight-medium)',
  },
  row28: {
    'margin-left': 'auto',
    display: 'flex',
    'flex-shrink': '0',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
  },
});

const buttonChildStyles = stylex.create({
  label: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: '0',
    margin: '-1px',
    overflow: 'hidden',
    'clip-path': 'inset(50%)',
    'white-space': 'nowrap',
    'border-width': '0',
  },
});

const buttonStyles = stylex.create({
  footer: {
    height: 'calc(var(--spacing) * 6)',
    width: 'calc(var(--spacing) * 6)',
    borderRadius: 'var(--radius-md)',
    color: {
      default: 'hsl(var(--sidebar-foreground))',
      ':where(.dark, .dark *)': 'hsl(var(--sidebar-foreground-muted))',
    },
  },
});

/* Display-only replica of the desktop `LoroSidebar` in Workspace organize mode,
   as the landing composes it: nav rows, a Local Projects section, the Chats
   group and the GitHub Worktrees repo groups (`session-list.tsx`), footer. */

const SIDEBAR_COPY: Record<
  ReplicaLocale,
  {
    home: string;
    search: string;
    back: string;
    forward: string;
    localProjects: string;
    chats: string;
    githubRepos: string;
    mergeable: string;
  }
> = {
  en: {
    home: 'New chat',
    search: 'Search',
    back: 'Back',
    forward: 'Forward',
    localProjects: 'Local Projects',
    chats: 'Chats',
    githubRepos: 'GitHub Worktrees',
    mergeable: 'Mergeable',
  },
  zh: {
    home: '新对话',
    search: '搜索',
    back: '后退',
    forward: '前进',
    localProjects: '本地项目',
    chats: '对话',
    githubRepos: 'GitHub Worktrees',
    mergeable: '可合并',
  },
};

const spin = stylex.keyframes({ to: { transform: 'rotate(360deg)' } });
const statusStyles = stylex.create({
  prOpen: { color: 'hsl(var(--github-open))' },
  prMerged: { color: 'hsl(var(--github-merged))' },
  prClosed: { color: 'hsl(var(--github-closed))' },
  prDraft: { color: 'hsl(var(--github-draft))' },
  success: { color: 'hsl(var(--status-success))' },
  failure: { color: 'hsl(var(--destructive))' },
  warning: { color: 'hsl(var(--status-warning))' },
  spinner: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    willChange: 'transform',
    animationName: spin,
    animationDuration: '1s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
  working: {
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 3)',
    color: 'hsl(var(--primary))',
  },
  projectWorking: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    color: 'hsl(var(--primary))',
  },
});

// ---- PR status icon (sidebar-row-shared `SessionPrIcon`) ---------------------

export const REPLICA_PR_STATUS_STYLES = {
  open: statusStyles.prOpen,
  merged: statusStyles.prMerged,
  closed: statusStyles.prClosed,
  draft: statusStyles.prDraft,
} satisfies Record<ReplicaPrStatus, stylex.StyleXStyles>;

const PR_STATUS_ICON: Record<ReplicaPrStatus, LucideIcon> = {
  open: GitPullRequest,
  merged: GitMerge,
  closed: GitPullRequestClosed,
  draft: GitPullRequestDraft,
};

type ReplicaCiState = NonNullable<ReplicaSessionRow['prCiState']>;

/** PR glyph with the CI verdict badge cut into its bottom-right corner. */
export function ReplicaPrIcon({
  status,
  ciState,
  className,
  xstyle,
}: {
  status: ReplicaPrStatus;
  ciState?: ReplicaCiState | null;
  className?: string;
  xstyle?: stylex.StyleXStyles;
}) {
  const maskId = `pr-ci-${ciState ?? 'none'}-${useId().replaceAll(':', '')}`;
  const ink = REPLICA_PR_STATUS_STYLES[status];
  const BaseIcon = PR_STATUS_ICON[status];
  if (!ciState) {
    return (
      <BaseIcon
        {...stylex.props(sidebarStates.prGlyph, ink, xstyle)}
        className={clsx(stylex.props(sidebarStates.prGlyph, ink, xstyle).className, className)}
        strokeWidth={2.25}
        aria-hidden="true"
      />
    );
  }
  const isRunning = ciState === 'pending';
  const VerdictIcon = ciState === 'success' ? Check : ciState === 'failure' ? X : null;
  const verdictXstyle =
    ciState === 'success'
      ? statusStyles.success
      : ciState === 'failure'
        ? statusStyles.failure
        : statusStyles.warning;
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...stylex.props(
        sidebarStates.ciGlyph,
        status === 'merged' && sidebarStates.mergedOffset,
        xstyle
      )}
      className={clsx(
        stylex.props(
          sidebarStates.ciGlyph,
          status === 'merged' && sidebarStates.mergedOffset,
          xstyle
        ).className,
        className
      )}
      data-pr-ci-verdict={ciState}
      aria-hidden="true"
    >
      <mask
        id={maskId}
        x="0"
        y="0"
        width="16"
        height="16"
        maskUnits="userSpaceOnUse"
        maskContentUnits="userSpaceOnUse"
      >
        <rect width="16" height="16" fill="white" />
        <circle cx="12" cy="12" r={isRunning ? 3.75 : 5} fill="black" />
      </mask>
      <g mask={`url(#${maskId})`}>
        <BaseIcon width={14} height={14} strokeWidth={2.25} {...stylex.props(ink)} />
      </g>
      <g transform="translate(7 7)">
        {isRunning ? (
          <circle cx="5" cy="5" r="2.5" fill="currentColor" {...stylex.props(verdictXstyle)} />
        ) : VerdictIcon ? (
          <VerdictIcon width={10} height={10} strokeWidth={3} {...stylex.props(verdictXstyle)} />
        ) : null}
      </g>
    </svg>
  );
}

// ---- Row building blocks -----------------------------------------------------

/* The app's `Spinner`: the rotation runs on an HTML wrapper, because an
   SVG rotation falls off the compositor on DPR≠1 displays. */
export function ReplicaSpinner({
  className,
  xstyle,
}: {
  className?: string;
  xstyle?: stylex.StyleXStyles;
}) {
  const sx = stylex.props(statusStyles.spinner, xstyle);
  return (
    <span {...sx} className={clsx(sx.className, className)}>
      <Loader2 {...stylex.props(sidebarStyles.glyph)} aria-hidden="true" />
    </span>
  );
}

/** ③ The row's single trailing status channel: waiting > working > unread > rest. */
function RowEndSlot({ row, rest }: { row: ReplicaSessionRow; rest?: ReactNode }) {
  const status = row.isWaitingPermission ? (
    <Hand {...stylex.props(sidebarStyles.glyph2)} />
  ) : row.isWorking ? (
    <ReplicaSpinner xstyle={statusStyles.working} />
  ) : row.hasUnreadMessages ? (
    <span {...stylex.props(sidebarStyles.surface)} />
  ) : null;
  const content = status ? (
    <div data-session-row-indicator="" {...stylex.props(sidebarStyles.row)}>
      {status}
    </div>
  ) : (
    rest
  );
  // Desktop rows always reserve the (hover-only) archive target, hence min-w-5.
  return (
    <div data-session-row-end-slot="" {...stylex.props(sidebarStyles.row2)}>
      {content ? <span {...stylex.props(sidebarStyles.row3)}>{content}</span> : null}
    </div>
  );
}

function MergeablePill({ label }: { label: string }) {
  return (
    <span data-session-mergeable-pill="" {...stylex.props(sidebarStyles.row4)}>
      {label}
    </span>
  );
}

/** One `SessionList` row (chat or GitHub repo group). */
function SessionListRowView({
  row,
  kind,
  selected,
  mergeableLabel,
}: {
  row: ReplicaSessionRow;
  kind: 'chat' | 'repo';
  selected: boolean;
  mergeableLabel: string;
}) {
  const hasPr = Boolean(row.prUrl || row.prNumber);
  const prStatus = row.prStatus ?? 'open';
  const showMergeablePill =
    hasPr &&
    Boolean(row.prMergeable) &&
    prStatus !== 'merged' &&
    prStatus !== 'closed' &&
    !selected;
  const rest =
    kind === 'chat' ? (
      <span {...stylex.props(sidebarStyles.row5)}>
        <span {...stylex.props(sidebarStyles.row6)}>
          <span {...stylex.props(sidebarStyles.label)}>{row.ageLabel}</span>
        </span>
      </span>
    ) : hasPr || showMergeablePill ? (
      <span {...stylex.props(sidebarStyles.row7)}>
        {showMergeablePill ? <MergeablePill label={mergeableLabel} /> : null}
        {hasPr ? (
          // Same 20px reserve as the app's compact `SessionPrIcon`: the end slot
          // centers a lone mark, so the pill must not be what widens that box.
          <span
            data-session-pr-icon-anchor=""
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center"
          >
            <ReplicaPrIcon status={prStatus} ciState={row.prCiState} />
          </span>
        ) : null}
      </span>
    ) : undefined;

  return (
    <div
      aria-current={selected ? 'page' : undefined}
      data-sidebar-session-id={row.id}
      className={clsx(
        stylex.props(sidebarStates.sessionRow, selected && sidebarStates.selectedRow).className,
        'group'
      )}
    >
      <div {...stylex.props(sidebarStyles.row8)}>
        <div data-session-row-leading-slot="" {...stylex.props(sidebarStyles.row9)} />
        <div
          {...stylex.props(
            sidebarStates.sessionTitle,
            selected ? sidebarStates.selectedInk : sidebarStates.idleInk
          )}
        >
          <span {...stylex.props(sidebarStyles.label2)}>{row.title}</span>
        </div>
        <RowEndSlot row={row} rest={rest} />
      </div>
    </div>
  );
}

/** A `SessionList` group: the Chats section or one GitHub repo. */
function SessionGroup({
  kind,
  label,
  ownerAvatarUrl,
  rows,
  selectedSessionId,
  mergeableLabel,
}: {
  kind: 'chat' | 'repo';
  label: string;
  ownerAvatarUrl?: string;
  rows: ReplicaSessionRow[];
  selectedSessionId: string | null;
  mergeableLabel: string;
}) {
  return (
    <div {...stylex.props(sidebarStyles.stack)}>
      <div
        className={[stylex.props(sidebarStyles.row10).className, 'group'].filter(Boolean).join(' ')}
      >
        <div
          {...stylex.props(
            sidebarBehavior.groupHeader,
            kind === 'repo' ? sidebarBehavior.repoHeader : sidebarBehavior.chatHeader
          )}
        >
          {kind === 'repo' ? (
            <span {...stylex.props(sidebarStyles.row11)}>
              {ownerAvatarUrl ? (
                <img
                  src={ownerAvatarUrl}
                  alt=""
                  aria-hidden="true"
                  {...stylex.props(sidebarStyles.overlay)}
                />
              ) : null}
            </span>
          ) : null}
          <span {...stylex.props(sidebarStyles.label3)}>{label}</span>
          <span {...stylex.props(sidebarStyles.label4)} aria-hidden="true" />
        </div>
      </div>
      <div {...stylex.props(sidebarStyles.stack2)}>
        {rows.map((row) => (
          <SessionListRowView
            key={row.id}
            row={row}
            kind={kind}
            selected={row.id === selectedSessionId}
            mergeableLabel={mergeableLabel}
          />
        ))}
      </div>
    </div>
  );
}

/** A local project folder group with its sessions (landing's local-project shape). */
function LocalProjectGroup({
  name,
  sessions,
  selectedSessionId,
}: {
  name: string;
  sessions: ReplicaSessionRow[];
  selectedSessionId: string | null;
}) {
  return (
    <div {...stylex.props(sidebarStates.compactGroup)}>
      <div
        className={[stylex.props(sidebarStyles.row12).className, 'group'].filter(Boolean).join(' ')}
      >
        <div
          className={[stylex.props(sidebarStyles.row13).className, 'group']
            .filter(Boolean)
            .join(' ')}
        >
          <span {...stylex.props(sidebarStyles.row11)}>
            <Folder {...stylex.props(sidebarStyles.glyph3)} />
          </span>
          <span {...stylex.props(sidebarStyles.label5)}>{name}</span>
        </div>
      </div>
      <div {...stylex.props(sidebarStyles.stack3)}>
        {sessions.map((row) => {
          const selected = row.id === selectedSessionId;
          return (
            <div
              key={row.id}
              aria-current={selected ? 'page' : undefined}
              data-sidebar-session-id={row.id}
              className={clsx(
                stylex.props(
                  sidebarStates.projectRow,
                  selected ? sidebarStates.selectedRow : sidebarStates.idleInk
                ).className,
                'group'
              )}
            >
              <div {...stylex.props(sidebarStyles.row14)}>
                <div {...stylex.props(sidebarStyles.row15)}>
                  {row.isWorking ? <ReplicaSpinner xstyle={statusStyles.projectWorking} /> : null}
                </div>
                <div {...stylex.props(sidebarStyles.section)}>
                  <div {...stylex.props(sidebarStyles.row16)}>
                    <div {...stylex.props(sidebarStyles.caption)}>
                      <span {...stylex.props(sidebarStyles.label6)}>{row.title}</span>
                    </div>
                    <span {...stylex.props(sidebarStyles.label7)}>{row.ageLabel}</span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Chrome ------------------------------------------------------------------

function NavRow({ active, label, icon }: { active: boolean; label: string; icon: ReactNode }) {
  return (
    <div {...stylex.props(sidebarStyles.row17)}>
      <button
        type="button"
        tabIndex={-1}
        className={clsx(
          stylex.props(
            sidebarBehavior.navRow,
            active ? sidebarBehavior.activeNav : sidebarBehavior.idleNav
          ).className,
          'group'
        )}
      >
        <span {...stylex.props(sidebarStyles.row18)}>{icon}</span>
        <span {...stylex.props(sidebarStyles.label6)}>{label}</span>
      </button>
    </div>
  );
}

function HeaderNavButton({ label, children }: { label: string; children: ReactNode }) {
  // The landing has no navigation history, so back/forward render disabled.
  return (
    <button type="button" aria-label={label} disabled {...stylex.props(sidebarStyles.row19)}>
      {children}
    </button>
  );
}

function FooterIconButton({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      tabIndex={-1}
      xstyle={buttonStyles.footer}
      iconSize="calc(var(--spacing) * 3.5)"
    >
      {children}
      <span {...stylex.props(buttonChildStyles.label)}>{label}</span>
    </Button>
  );
}

export type ReplicaSidebarProject = { name: string; sessions: ReplicaSessionRow[] };

export type ReplicaSidebarRepo = {
  repoFullName: string;
  ownerAvatarUrl: string;
  sessions: ReplicaSessionRow[];
};

export type ReplicaSidebarProps = {
  locale: ReplicaLocale;
  workspace: { name: string; logoUrl: string };
  /** The worktree demo's freshly created project; rendered above `localProjects`. */
  demoProject: ReplicaSidebarProject | null;
  localProjects: ReplicaSidebarProject[];
  chats: ReplicaSessionRow[];
  github: ReplicaSidebarRepo[];
  selectedSessionId: string | null;
  /** "New chat" nav row highlighted (chat landing visible). */
  homeActive: boolean;
  width?: number;
};

export function ReplicaSidebar({
  locale,
  workspace,
  demoProject,
  localProjects,
  chats,
  github,
  selectedSessionId,
  homeActive,
  width = 296,
}: ReplicaSidebarProps) {
  const copy = SIDEBAR_COPY[locale];
  const projects = demoProject ? [demoProject, ...localProjects] : localProjects;
  const hasGithubRows = github.some((repo) => repo.sessions.length > 0);

  return (
    <div {...stylex.props(sidebarStyles.surface2)}>
      <div
        {...stylex.props(sidebarStyles.frame)}
        style={{ width, minWidth: width, maxWidth: width }}
      >
        <div {...stylex.props(sidebarStyles.stack4)}>
          <div
            className={[stylex.props(sidebarStyles.row20).className, 'group/sidebar-header']
              .filter(Boolean)
              .join(' ')}
          >
            <span
              aria-label="Lody"
              {...stylex.props(sidebarStyles.label8)}
              style={{ fontFamily: 'var(--font-wordmark)' }}
            >
              Lody
            </span>
            <div {...stylex.props(sidebarStyles.row21)}>
              <HeaderNavButton label={copy.back}>
                <ChevronLeft {...stylex.props(sidebarStyles.glyph4)} />
              </HeaderNavButton>
              <HeaderNavButton label={copy.forward}>
                <ChevronRight {...stylex.props(sidebarStyles.glyph4)} />
              </HeaderNavButton>
            </div>
          </div>

          <div {...stylex.props(sidebarStyles.stack5)}>
            <NavRow
              active={homeActive}
              label={copy.home}
              icon={<SquarePen {...stylex.props(sidebarStyles.glyph5)} />}
            />
            <NavRow
              active={false}
              label={copy.search}
              icon={<Search {...stylex.props(sidebarStyles.glyph5)} />}
            />
          </div>

          <div {...stylex.props(sidebarStyles.frame2)}>
            <div {...stylex.props(sidebarStyles.section2)}>
              <div {...stylex.props(sidebarStyles.section3)}>
                <div {...stylex.props(sidebarStyles.section4)}>
                  <div {...stylex.props(sidebarStates.sections)}>
                    <div {...stylex.props(sidebarStates.groups)}>
                      <div {...stylex.props(sidebarStates.compactGroup)}>
                        <div
                          className={[stylex.props(sidebarStyles.row22).className, 'group']
                            .filter(Boolean)
                            .join(' ')}
                        >
                          <div {...stylex.props(sidebarStyles.row23)}>
                            <span {...stylex.props(sidebarStyles.label9)}>
                              {copy.localProjects}
                            </span>
                            <span {...stylex.props(sidebarStyles.label4)} aria-hidden="true" />
                          </div>
                        </div>
                        <div {...stylex.props(sidebarStates.projects)}>
                          {projects.map((project) => (
                            <LocalProjectGroup
                              key={project.name}
                              name={project.name}
                              sessions={project.sessions}
                              selectedSessionId={selectedSessionId}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                    {chats.length ? (
                      <div {...stylex.props(sidebarStyles.stack6)}>
                        <SessionGroup
                          kind="chat"
                          label={copy.chats}
                          rows={chats}
                          selectedSessionId={selectedSessionId}
                          mergeableLabel={copy.mergeable}
                        />
                      </div>
                    ) : null}
                    {hasGithubRows ? (
                      <div {...stylex.props(sidebarStyles.caption2)}>{copy.githubRepos}</div>
                    ) : null}
                  </div>
                </div>
                <div {...stylex.props(sidebarStyles.stack6)}>
                  {github
                    .filter((repo) => repo.sessions.length > 0)
                    .map((repo) => (
                      <div
                        key={repo.repoFullName}
                        {...stylex.props(sidebarStyles.frame3)}
                        data-repo-full-name={repo.repoFullName}
                      >
                        <SessionGroup
                          kind="repo"
                          label={repo.repoFullName}
                          ownerAvatarUrl={repo.ownerAvatarUrl}
                          rows={repo.sessions}
                          selectedSessionId={selectedSessionId}
                          mergeableLabel={copy.mergeable}
                        />
                      </div>
                    ))}
                </div>
              </div>
            </div>
          </div>

          <div {...stylex.props(sidebarStyles.row24)}>
            <div {...stylex.props(sidebarStyles.section)}>
              <div {...stylex.props(sidebarStyles.row25)}>
                <span {...stylex.props(sidebarStyles.row26)}>
                  <img
                    src={workspace.logoUrl}
                    alt={workspace.name}
                    {...stylex.props(sidebarStyles.frame4)}
                  />
                </span>
                <span {...stylex.props(sidebarStyles.row27)}>
                  <span {...stylex.props(sidebarStyles.label10)}>{workspace.name}</span>
                </span>
              </div>
            </div>
            <div {...stylex.props(sidebarStyles.row28)}>
              <FooterIconButton label="Settings">
                <Settings strokeWidth={1.5} />
              </FooterIconButton>
              <FooterIconButton label="Help">
                <CircleHelp strokeWidth={1.5} />
              </FooterIconButton>
              <FooterIconButton label="Archive">
                <Archive strokeWidth={1.5} />
              </FooterIconButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

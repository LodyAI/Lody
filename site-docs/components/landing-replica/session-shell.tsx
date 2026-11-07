import * as stylex from '@stylexjs/stylex';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  Ellipsis,
  FileDiff,
  Files,
  GitBranch,
  GitPullRequest,
  MonitorPlay,
  PanelRight,
  Plus,
  SquareTerminal,
  X,
} from 'lucide-react';
import { Button } from './button';
import { AgentIcon, WorktreeIcon } from './icons';
import { REPLICA_PR_STATUS_STYLES, ReplicaPrIcon } from './sidebar';
import type { ReplicaAgent, ReplicaLocale, ReplicaPrStatus } from './types';
const sessionShellCompositionNative = stylex.create({
  part1: {
    position: 'relative',
    display: 'flex',
    width: '1px',
    'align-items': 'center',
    'justify-content': 'center',
    'background-color': 'transparent',
    'transition-property': 'opacity',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
  },
  part2: {
    ':is(*)::after': {
      content: '""',
      position: 'absolute',
      'inset-block': '0px',
      left: '0px',
      width: '2px',
      translate: '0px 0',
    },
  },
  part3: {
    ':is(*)::after': {
      content: '""',
      'transition-property':
        'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
      'transition-timing-function': 'var(--default-transition-timing-function)',
      'transition-duration': '150ms',
    },
  },
  part4: {
    ':is(*)[data-resize-handle-state="hover"]::after': {
      content: '""',
      'background-color': 'color-mix(in oklab, hsl(var(--sidebar-ring)) 50%, transparent)',
    },
  },
  part5: {
    ':is(*)[data-resize-handle-state="hover"]::after': {
      'transition-delay': '150ms',
      content: '""',
      'animation-delay': '.15s',
    },
  },
  part6: {
    ':is(*)[data-resize-handle-state="drag"]::after': {
      content: '""',
      'background-color': 'color-mix(in oklab, hsl(var(--sidebar-ring)) 70%, transparent)',
    },
  },
  part7: {
    opacity: '100%',
  },
  part8: {
    'pointer-events': 'none',
    opacity: '0%',
  },
});

const sessionStatus = stylex.create({
  desktop: {
    display: 'flex',
    height: 'calc(var(--spacing) * 6)',
    flexShrink: 0,
    userSelect: 'none',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1)',
    borderRadius: 'var(--radius-md)',
    paddingInline: 'calc(var(--spacing) * 1)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    fontWeight: 'var(--font-weight-semibold)',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionDuration: 'var(--default-transition-duration)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
  },
  mobile: {
    display: 'flex',
    height: 'calc(var(--spacing) * 6)',
    flexShrink: 0,
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1)',
    paddingInline: 'calc(var(--spacing) * 1)',
    fontWeight: 'var(--font-weight-semibold)',
  },
  worktree: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
  },
});
const sessionShellComposition = stylex.create({
  part1: {
    'min-width': '0px',
    flex: '1',
    overflow: 'hidden',
  },
  part2: {
    'container-type': 'inline-size',
  },
  part3: {
    'min-width': '0px',
    overflow: 'hidden',
  },
  part4: {
    '@container (width >= 366px)': {
      'min-width': 'var(--tab-active-min-width)',
    },
  },
  part5: {
    position: 'relative',
    display: 'flex',
    height: 'calc(var(--spacing) * 8)',
    width: '100%',
    'min-width': '0px',
    cursor: 'default',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    overflow: 'hidden',
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'transparent',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'font-size': '0.9em',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
  },
  part6: {
    color: 'hsl(var(--tab-active-foreground))',
  },
  part7: {
    'background-color': 'color-mix(in oklab, hsl(var(--foreground)) 8%, transparent)',
    color: 'hsl(var(--tab-active-foreground))',
  },
  part8: {
    'background-color':
      'color-mix(in oklab, hsl(var(--foreground)) 3.5000000000000004%, transparent)',
    color: 'hsl(var(--tab-inactive-foreground))',
  },
  part9: {
    display: 'flex',
    height: 'calc(var(--spacing) * 7)',
    width: 'calc(var(--spacing) * 7)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
    'border-radius': 'var(--radius-md)',
    color: 'hsl(var(--muted-foreground))',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
  },
  part10: {
    position: 'relative',
    display: 'flex',
    width: '1px',
    'align-items': 'center',
    'justify-content': 'center',
    'background-color': 'transparent',
    'transition-property': 'opacity',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
  },
  part11: {
    ':is(*)::after': {
      content: '""',
      position: 'absolute',
      'inset-block': '0px',
      left: '0px',
      width: '2px',
      translate: '0px 0',
    },
  },
  part12: {
    ':is(*)::after': {
      content: '""',
      'transition-property':
        'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
      'transition-timing-function': 'var(--default-transition-timing-function)',
      'transition-duration': '150ms',
    },
  },
  part13: {
    ':is(*)[data-resize-handle-state="hover"]::after': {
      content: '""',
      'background-color': 'color-mix(in oklab, hsl(var(--sidebar-ring)) 50%, transparent)',
    },
  },
  part14: {
    overflow: 'hidden',
    'background-color': 'hsl(var(--background))',
    '@media (prefers-reduced-motion: reduce)': {
      'transition-property': 'none',
    },
  },
  part15: {
    'transition-property': 'flex-grow,min-width',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
  },
  part16: {
    height: '100%',
    'transition-property': 'transform, translate, scale, rotate',
    'transition-timing-function': 'cubic-bezier(0.32,0.72,0,1)',
    'transition-duration': '220ms',
    '@media (prefers-reduced-motion: reduce)': {
      'transition-property': 'none',
    },
  },
  part17: {
    'pointer-events': 'none',
    visibility: 'hidden',
    translate: '100% 0',
  },
  part18: {
    position: 'relative',
    display: 'flex',
    height: 'calc(var(--spacing) * 7)',
    'max-width': '180px',
    'flex-shrink': '0',
    cursor: 'default',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'border-radius': 'var(--radius-md)',
    'font-size': '0.9em',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    '@container side-tabs (width < 420px)': {
      'max-width': '175px',
    },
  },
  part19: {
    'padding-inline': 'calc(var(--spacing) * 3)',
  },
  part20: {
    'padding-inline': 'calc(var(--spacing) * 2)',
  },
  part21: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  },
  part22: {
    'font-family': 'var(--font-mono)',
  },
  part23: {
    'margin-left': 'auto',
    'flex-shrink': '0',
    'border-radius': 'var(--radius-sm)',
    padding: 'calc(var(--spacing) * 0.5)',
    'transition-property': 'opacity,background-color,color',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
  },
  part24: {
    opacity: '100%',
  },
  part25: {
    opacity: '0%',
  },
  part26: {
    display: 'flex',
    height: 'calc(var(--spacing) * 6)',
    'flex-shrink': '0',
    'align-items': 'center',
    gap: 'var(--spacing)',
    'border-radius': 'var(--radius-md)',
    'padding-inline': 'var(--spacing)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    '-webkit-user-select': 'none',
    'user-select': 'none',
  },
  part27: {
    display: 'flex',
    height: 'calc(var(--spacing) * 6)',
    'flex-shrink': '0',
    'align-items': 'center',
    gap: 'var(--spacing)',
    'padding-inline': 'var(--spacing)',
    'font-weight': 'var(--font-weight-semibold)',
  },
  part28: {
    width: '100%',
    'flex-shrink': '0',
    'background-color': 'hsl(var(--background))',
    'padding-bottom': 'calc(var(--spacing) * 2)',
  },
  part29: {
    position: 'relative',
    'z-index': '40',
  },
  part30: {
    display: 'flex',
    height: 'calc(var(--spacing) * 6)',
    'flex-shrink': '0',
    'align-items': 'center',
    gap: 'var(--spacing)',
    'border-radius': 'var(--radius-md)',
    'padding-inline': 'var(--spacing)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    '-webkit-user-select': 'none',
    'user-select': 'none',
  },
  part31: {
    color: 'var(--color-emerald-600)',
    ':is(*):where(.dark, .dark *)': {
      color: 'var(--color-emerald-400)',
    },
  },
});

const sessionShellStylesNative = stylex.create({
  row: {
    display: 'flex',
    height: 'calc(var(--spacing) * 7)',
    width: 'calc(var(--spacing) * 7)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
    'border-radius': 'var(--radius-md)',
    color: 'hsl(var(--muted-foreground))',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    ':is(*):disabled': {
      cursor: 'default',
      opacity: '35%',
    },
  },
  row2: {
    display: 'flex',
    'flex-shrink': '0',
    'align-items': 'center',
    'padding-inline': 'calc(var(--spacing) * 1.5)',
    'padding-block': 'calc(var(--spacing) * 0.5)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-medium)',
    color: 'hsl(var(--muted-foreground))',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    'outline-style': 'none',
    '-webkit-user-select': 'none',
    'user-select': 'none',
    ':is(*):where(.dark, .dark *)': {
      color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 80%, transparent)',
    },
  },
  row3: {
    position: 'relative',
    display: 'flex',
    width: 'calc(var(--spacing) * 5)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
    'align-self': 'stretch',
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 75%, transparent)',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    'outline-style': 'none',
    ':is(*)::before': {
      content: '""',
      position: 'absolute',
      left: '0px',
      height: 'calc(var(--spacing) * 3)',
      width: '1px',
      'background-color': 'color-mix(in oklab, hsl(var(--foreground)) 10%, transparent)',
    },
    ':is(*):where(.dark, .dark *)::before': {
      content: '""',
      'background-color': 'color-mix(in oklab, hsl(var(--muted-foreground)) 15%, transparent)',
    },
  },
  row4: {
    'margin-inline': 'calc(var(--spacing) * -1)',
    display: 'flex',
    height: 'calc(var(--spacing) * 6)',
    'min-width': '0px',
    'flex-shrink': '1',
    'align-items': 'center',
    'border-radius': 'var(--radius-md)',
    'padding-inline': 'var(--spacing)',
    color: 'color-mix(in oklab, hsl(var(--foreground)) 85%, transparent)',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
  },
  row5: {
    'margin-inline': 'calc(var(--spacing) * -1)',
    display: 'flex',
    height: 'calc(var(--spacing) * 6)',
    'flex-shrink': '0',
    'align-items': 'center',
    gap: 'var(--spacing)',
    'border-radius': 'var(--radius-md)',
    'padding-inline': 'var(--spacing)',
    'font-variant-numeric': '   tabular-nums ',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    ':is(*):disabled': {
      'pointer-events': 'none',
    },
  },
});

const sessionShellStyles = stylex.create({
  row: {
    'container-type': 'inline-size',
    'container-name': 'session-page',
    display: 'flex',
    height: 'calc(var(--spacing) * 11)',
    'min-width': '0px',
    'align-items': 'center',
    'background-color': 'hsl(var(--background))',
  },
  row2: {
    display: 'flex',
    height: 'calc(var(--spacing) * 11)',
    'max-height': '100%',
    width: '100%',
    'align-items': 'center',
  },
  row3: {
    display: 'inline-flex',
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 3)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
  },
  label: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  },
  row4: {
    display: 'flex',
    'flex-shrink': '0',
    'align-items': 'center',
  },
  glyph: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
  },
  row5: {
    display: 'flex',
    height: '100%',
    'flex-shrink': '0',
    'align-items': 'center',
    gap: 'var(--spacing)',
    'padding-right': 'calc(var(--spacing) * 2)',
    'padding-left': 'var(--spacing)',
  },
  frame: {
    position: 'relative',
    height: '100%',
    width: '100%',
  },
  row6: {
    display: 'flex',
    height: '100%',
    width: '100%',
  },
  section: {
    'min-width': '280px',
    overflow: 'hidden',
  },
  stack: {
    display: 'flex',
    height: '100%',
    'flex-direction': 'column',
    'background-color': 'hsl(var(--background))',
  },
  stack2: {
    display: 'flex',
    'min-height': '0px',
    flex: '1',
    'flex-direction': 'column',
  },
  frame2: {
    'min-height': '0px',
    flex: '1',
    overflow: 'hidden',
  },
  stack3: {
    display: 'flex',
    height: '100%',
    'min-width': '0px',
    'flex-direction': 'column',
    overflow: 'hidden',
    'border-left-style': 'solid',
    'border-left-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
    'background-color': 'hsl(var(--background))',
  },
  glyph2: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    opacity: '70%',
  },
  row7: {
    'container-type': 'inline-size',
    'container-name': 'side-tabs',
    display: 'flex',
    height: 'calc(var(--spacing) * 11)',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'var(--spacing)',
    'border-bottom-style': 'solid',
    'border-bottom-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border)) 50%, transparent)',
    'background-color': 'hsl(var(--background))',
    'padding-inline': 'calc(var(--spacing) * 2)',
  },
  section2: {
    'min-width': '0px',
    flex: '1',
    overflow: 'hidden',
  },
  row8: {
    display: 'flex',
    height: 'calc(var(--spacing) * 10)',
    width: 'max-content',
    'min-width': '100%',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
  },
  label2: {
    'flex-shrink': '0',
  },
  glyph3: {
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 3)',
  },
  row9: {
    display: 'flex',
    'flex-shrink': '0',
    'align-items': 'center',
    overflow: 'hidden',
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--foreground)) 8%, transparent)',
    'background-color': 'color-mix(in oklab, hsl(var(--foreground)) 3%, transparent)',
    ':is(*):where(.dark, .dark *)': {
      'border-color': 'transparent',
      'background-color': 'color-mix(in oklab, hsl(var(--muted-foreground)) 8%, transparent)',
    },
  },
  glyph4: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
  },
  frame3: {
    height: 'var(--spacing)',
    width: '100%',
    'flex-shrink': '0',
  },
  row10: {
    display: 'flex',
    height: 'calc(var(--spacing) * 6)',
    'flex-shrink': '0',
    'align-items': 'center',
    'padding-inline': 'var(--spacing)',
    color: 'hsl(var(--muted-foreground))',
    '-webkit-user-select': 'none',
    'user-select': 'none',
  },
  label3: {
    display: 'none',
    'flex-shrink': '0',
    'font-variant-numeric': '   tabular-nums ',
    '@container (width >= 420px)': {
      display: 'inline',
    },
  },
  row11: {
    display: 'flex',
    height: 'calc(var(--spacing) * 6)',
    'flex-shrink': '0',
    'align-items': 'center',
    gap: 'var(--spacing)',
    'padding-inline': 'var(--spacing)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground))',
    '-webkit-user-select': 'none',
    'user-select': 'none',
  },
  glyph5: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    'flex-shrink': '0',
  },
  row12: {
    display: 'flex',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'font-weight': 'var(--font-weight-normal)',
  },
  label4: {
    'min-width': '0px',
    'flex-shrink': '2',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    color: 'hsl(var(--muted-foreground))',
  },
  label5: {
    color: 'hsl(var(--code-added))',
  },
  label6: {
    color: 'hsl(var(--code-removed))',
  },
  frame4: {
    'margin-inline': 'auto',
    width: '100%',
    'max-width': '46rem',
    'padding-inline': '14px',
    '@media (width >= 40rem)': {
      'padding-inline': '18px',
    },
  },
  row13: {
    'container-type': 'inline-size',
    display: 'flex',
    height: 'calc(var(--spacing) * 8)',
    width: '100%',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '0.5px',
    'border-color': 'color-mix(in oklab, hsl(var(--foreground)) 10%, transparent)',
    'background-color': 'hsl(var(--composer))',
    'padding-inline': 'calc(var(--spacing) * 2.5)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0.5px 1px 1px rgba(0,0,0,0.04)',
    '-webkit-user-select': 'none',
    'user-select': 'none',
    ':is(*):where(.dark, .dark *)': {
      'border-color': 'color-mix(in oklab, hsl(var(--input-border)) 45%, transparent)',
      'background-color': 'color-mix(in oklab, hsl(var(--input)) 70%, transparent)',
      'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000',
    },
  },
  surface: {
    height: 'calc(var(--spacing) * 3.5)',
    width: '1px',
    'flex-shrink': '0',
    'background-color': 'color-mix(in oklab, hsl(var(--muted-foreground)) 25%, transparent)',
  },
  row14: {
    display: 'flex',
    'min-width': '0px',
    flex: '1',
    'align-items': 'center',
  },
  row15: {
    display: 'flex',
    'min-width': '0px',
    flex: '1',
    'align-items': 'center',
    gap: 'var(--spacing)',
  },
  row16: {
    display: 'flex',
    height: 'calc(var(--spacing) * 6)',
    'min-width': '0px',
    flex: '1',
    'align-items': 'center',
    gap: 'var(--spacing)',
    'border-radius': 'var(--radius-md)',
    'padding-inline': 'var(--spacing)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground))',
  },
  label7: {
    'min-width': '0px',
    flex: '1',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'text-align': 'left',
  },
});

const buttonStyles = stylex.create({
  tabAgent: { height: 'calc(var(--spacing) * 3)', width: 'calc(var(--spacing) * 3)', opacity: 0.6 },
  control: {
    height: 'calc(var(--spacing) * 7)',
    width: 'calc(var(--spacing) * 7)',
    flexShrink: 0,
    color: 'hsl(var(--muted-foreground))',
  },
  closedPanel: { marginRight: 9 },
});

/* Display-only replicas of the desktop session shell (`sessions/`): the merged
   top row (`SessionTabBar variant="session"` + toolbar), the resizable
   chat/right-panel split (`DesktopSessionDetailLayout`), the right panel's tab
   strip (`SessionSidePanelTabBar`) and the composer info bar (`SessionInfoBar`). */

const SHELL_COPY: Record<
  ReplicaLocale,
  {
    newTab: string;
    sessionTabs: string;
    openInEditor: string;
    moreActions: string;
    showPanel: string;
    hidePanel: string;
    addPanel: string;
    closeTab: (label: string) => string;
    browser: string;
    allChanges: string;
  }
> = {
  en: {
    newTab: 'New tab',
    sessionTabs: 'Session tabs',
    openInEditor: 'Open in editor',
    moreActions: 'More actions',
    showPanel: 'Show sidebar',
    hidePanel: 'Hide sidebar',
    addPanel: 'Add panel',
    closeTab: (label) => `Close ${label}`,
    browser: 'Browser',
    allChanges: 'All Changes',
  },
  zh: {
    newTab: '新标签页',
    sessionTabs: '会话标签页',
    openInEditor: '在编辑器中打开',
    moreActions: '更多操作',
    showPanel: '显示侧边栏',
    hidePanel: '隐藏侧边栏',
    addPanel: '添加面板',
    closeTab: (label) => `关闭 ${label}`,
    browser: '浏览器',
    allChanges: '全部变更',
  },
};

// Shared by the session tabs and the right-panel tabs (`TAB_PILL_*_CLASS`).
const tabPillActiveStyle = sessionShellComposition.part7;
const tabPillInactiveStyle = sessionShellComposition.part8;
const tabBarActionStyle = sessionShellComposition.part9;

// ---- Session tab bar ---------------------------------------------------------

export type ReplicaSessionTab = { id: string; title: string; agent: ReplicaAgent };

export function ReplicaSessionTabBar({
  tabs,
  activeTabId,
  rightSlot,
  locale = 'en',
}: {
  tabs: ReplicaSessionTab[];
  activeTabId: string;
  rightSlot?: ReactNode;
  locale?: ReplicaLocale;
}) {
  const copy = SHELL_COPY[locale];
  // A lone tab spans the whole row, so it drops the active fill.
  const solo = tabs.length === 1;
  return (
    <div {...stylex.props(sessionShellStyles.row)}>
      <div
        {...stylex.props([
          sessionShellComposition.part1,
          tabs.length > 1 && sessionShellComposition.part2,
        ])}
        data-adaptive-tab-strip-viewport=""
      >
        <div
          role="tablist"
          aria-label={copy.sessionTabs}
          {...stylex.props(sessionShellStyles.row2)}
          style={{ boxSizing: 'border-box', paddingLeft: 8, paddingRight: 8 }}
        >
          {tabs.map((tab, index) => {
            const active = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                {...stylex.props([
                  sessionShellComposition.part3,
                  active && !solo && sessionShellComposition.part4,
                ])}
                style={{
                  flex: '1 1 0',
                  marginRight: index === tabs.length - 1 ? 0 : 6,
                  ...(active ? { ['--tab-active-min-width' as string]: '180px' } : null),
                }}
              >
                <div
                  role="tab"
                  aria-selected={active}
                  aria-label={tab.title}
                  className={[
                    stylex.props([
                      sessionShellComposition.part5,
                      solo
                        ? sessionShellComposition.part6
                        : active
                          ? tabPillActiveStyle
                          : tabPillInactiveStyle,
                    ]).className,
                    'group',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <span {...stylex.props(sessionShellStyles.row3)}>
                    <AgentIcon agent={tab.agent} xstyle={buttonStyles.tabAgent} />
                  </span>
                  <span {...stylex.props(sessionShellStyles.label)}>{tab.title}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div {...stylex.props(sessionShellStyles.row4)}>
        <button
          type="button"
          tabIndex={-1}
          {...stylex.props(tabBarActionStyle)}
          aria-label={copy.newTab}
        >
          <Plus {...stylex.props(sessionShellStyles.glyph)} />
        </button>
        {rightSlot}
      </div>
    </div>
  );
}

// ---- Toolbar + panel toggle ----------------------------------------------------

/** `session-detail.tsx`'s `sidebarToggleButton`; also the right panel tab bar's end slot. */
export function ReplicaPanelToggle({
  locale,
  panelOpen,
}: {
  locale: ReplicaLocale;
  panelOpen: boolean;
}) {
  const copy = SHELL_COPY[locale];
  return (
    <Button
      variant="ghost"
      size="icon"
      tabIndex={-1}
      data-demo="toggle-panel"
      aria-label={panelOpen ? copy.hidePanel : copy.showPanel}
      xstyle={[buttonStyles.control, !panelOpen && buttonStyles.closedPanel]}
    >
      <PanelRight />
    </Button>
  );
}

/** Right-side controls of the merged top row (`headerVariant="toolbar"`). */
export function ReplicaSessionToolbar({
  locale,
  panelOpen,
}: {
  locale: ReplicaLocale;
  panelOpen: boolean;
}) {
  const copy = SHELL_COPY[locale];
  return (
    <div data-power-demo-layout="fill" {...stylex.props(sessionShellStyles.row5)}>
      <Button
        variant="ghost"
        size="icon"
        tabIndex={-1}
        xstyle={buttonStyles.control}
        aria-label={copy.openInEditor}
      >
        <SquareTerminal />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        tabIndex={-1}
        xstyle={buttonStyles.control}
        aria-label={copy.moreActions}
      >
        <Ellipsis />
      </Button>
      {panelOpen ? null : <ReplicaPanelToggle locale={locale} panelOpen={false} />}
    </div>
  );
}

// ---- Resizable chat / right-panel split ---------------------------------------

const PANEL_MIN_WIDTH_PX = 280;
const CHAT_MIN_WIDTH_PX = 280;
const PANEL_MIN_PERCENT = 10;
const CHAT_MIN_PERCENT = 15;
// react-resizable-panels' fine-pointer hit margin around the handle.
const HANDLE_HIT_MARGIN_PX = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * `DesktopSessionDetailLayout` without react-resizable-panels. The ghost demo
 * drags the handle with synthetic events: `pointerdown` on the handle, then
 * bubbling `pointermove`/`pointerup` on `document.body`, so the drag listens on
 * `window`. Sizes are percentages of the group, like the library's, and the
 * layout is not persisted (the landing remounts it per demo).
 */
export function ReplicaSessionLayout({
  topBar,
  chat,
  panel,
  panelOpen,
  defaultPanelPercent = 25,
}: {
  topBar: ReactNode;
  chat: ReactNode;
  /** Right-panel content (tab bar + body); wrapped in the bordered panel column here. */
  panel: ReactNode;
  panelOpen: boolean;
  defaultPanelPercent?: number;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const [panelPercent, setPanelPercent] = useState(defaultPanelPercent);
  const percentRef = useRef(panelPercent);
  percentRef.current = panelPercent;
  const openRef = useRef(panelOpen);
  openRef.current = panelOpen;
  const [handleState, setHandleState] = useState<'inactive' | 'hover' | 'drag'>('inactive');

  useEffect(() => {
    const handle = handleRef.current;
    const group = groupRef.current;
    if (!handle || !group) return undefined;
    let drag: { startX: number; startPercent: number; groupWidth: number } | null = null;

    const isOverHandle = (event: PointerEvent) => {
      const rect = handle.getBoundingClientRect();
      return (
        event.clientX >= rect.left - HANDLE_HIT_MARGIN_PX &&
        event.clientX <= rect.right + HANDLE_HIT_MARGIN_PX &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      );
    };
    // Only the ghost's synthetic events paint hover: the real pointer never
    // reaches the inert frame, and skipping it avoids a layout read per mousemove.
    const syncHover = (event: PointerEvent) => {
      if (event.isTrusted) return;
      setHandleState(openRef.current && isOverHandle(event) ? 'hover' : 'inactive');
    };
    const onHandleDown = (event: PointerEvent) => {
      if (!openRef.current || !event.isPrimary || (event.buttons & 1) === 0) return;
      event.preventDefault();
      event.stopPropagation();
      // Screen-space width: the landing stage is CSS-scaled, and clientX deltas
      // are in the same scaled space.
      drag = {
        startX: event.clientX,
        startPercent: percentRef.current,
        groupWidth: group.getBoundingClientRect().width || 1,
      };
      setHandleState('drag');
    };
    const onMove = (event: PointerEvent) => {
      if (!drag) {
        syncHover(event);
        return;
      }
      // Pixel minimums are layout px, so they convert against the unscaled width.
      const layoutWidth = group.offsetWidth || 1;
      const min = Math.max(PANEL_MIN_PERCENT, (PANEL_MIN_WIDTH_PX / layoutWidth) * 100);
      const max = 100 - Math.max(CHAT_MIN_PERCENT, (CHAT_MIN_WIDTH_PX / layoutWidth) * 100);
      const delta = ((event.clientX - drag.startX) / drag.groupWidth) * 100;
      const next = clamp(drag.startPercent - delta, min, Math.max(min, max));
      percentRef.current = next;
      setPanelPercent(next);
    };
    const onUp = (event: PointerEvent) => {
      drag = null;
      syncHover(event);
    };
    const onDown = (event: PointerEvent) => {
      if (!drag) syncHover(event);
    };

    handle.addEventListener('pointerdown', onHandleDown);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      handle.removeEventListener('pointerdown', onHandleDown);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  useEffect(() => {
    if (!panelOpen) setHandleState('inactive');
  }, [panelOpen]);

  const isDragging = handleState === 'drag';
  const size = panelOpen ? panelPercent : 0;

  return (
    <div {...stylex.props(sessionShellStyles.frame)}>
      <div
        ref={groupRef}
        data-slot="resizable-panel-group"
        data-panel-group-direction="horizontal"
        data-power-demo-layout="fill"
        {...stylex.props(sessionShellStyles.row6)}
      >
        <div
          data-slot="resizable-panel"
          {...stylex.props(sessionShellStyles.section)}
          style={{ flex: `${100 - size} 1 0px` }}
        >
          <div
            data-power-demo-layout="fill"
            className={[stylex.props(sessionShellStyles.stack).className, 'group/close-scope']
              .filter(Boolean)
              .join(' ')}
          >
            {topBar}
            <div data-power-demo-layout="fill" {...stylex.props(sessionShellStyles.stack2)}>
              <div {...stylex.props(sessionShellStyles.frame2)}>{chat}</div>
            </div>
          </div>
        </div>

        <div
          ref={handleRef}
          data-slot="resizable-handle"
          data-panel-group-direction="horizontal"
          data-resize-handle-state={handleState}
          aria-hidden="true"
          {...stylex.props([
            sessionShellCompositionNative.part1,
            sessionShellCompositionNative.part2,
            sessionShellCompositionNative.part3,
            sessionShellCompositionNative.part4,
            sessionShellCompositionNative.part5,
            sessionShellCompositionNative.part6,
            panelOpen ? sessionShellCompositionNative.part7 : sessionShellCompositionNative.part8,
          ])}
          style={{ transitionDuration: '220ms' }}
        />

        <div
          data-slot="resizable-panel"
          {...stylex.props([
            sessionShellComposition.part14,
            !isDragging && sessionShellComposition.part15,
          ])}
          style={{
            flex: `${size} 1 0px`,
            minWidth: panelOpen ? PANEL_MIN_WIDTH_PX : 0,
            transitionDuration: isDragging ? '0ms' : '220ms',
            transitionTimingFunction: 'cubic-bezier(0.32, 0.72, 0, 1)',
          }}
        >
          <div
            aria-hidden={!panelOpen}
            {...stylex.props([
              sessionShellComposition.part16,
              !panelOpen && sessionShellComposition.part17,
            ])}
          >
            <div
              data-power-demo-layout="fill"
              className={[stylex.props(sessionShellStyles.stack3).className, 'group/close-scope']
                .filter(Boolean)
                .join(' ')}
            >
              {panel}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Right-panel tab strip -----------------------------------------------------

export type ReplicaSidePanelTab = {
  id: string;
  label: string;
  kind: 'files' | 'changes' | 'pr' | 'browser' | 'diff';
  closeable?: boolean;
};

function SidePanelTabIcon({ kind }: { kind: ReplicaSidePanelTab['kind'] }) {
  switch (kind) {
    case 'files':
      return <Files {...stylex.props(sessionShellStyles.glyph2)} />;
    case 'changes':
    case 'diff':
      return <FileDiff {...stylex.props(sessionShellStyles.glyph2)} />;
    case 'pr':
      return <GitPullRequest {...stylex.props(sessionShellStyles.glyph2)} />;
    case 'browser':
      return <MonitorPlay {...stylex.props(sessionShellStyles.glyph2)} />;
    default:
      return null;
  }
}

export function ReplicaSidePanelTabBar({
  tabs,
  activeTabId,
  endSlot,
  locale,
}: {
  tabs: ReplicaSidePanelTab[];
  activeTabId: string | null;
  endSlot?: ReactNode;
  locale: ReplicaLocale;
}) {
  const copy = SHELL_COPY[locale];
  return (
    <div {...stylex.props(sessionShellStyles.row7)}>
      <div {...stylex.props(sessionShellStyles.section2)}>
        <div role="tablist" {...stylex.props(sessionShellStyles.row8)}>
          {tabs.map((tab) => {
            const active = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={active}
                className={[
                  stylex.props([
                    sessionShellComposition.part18,
                    tab.closeable ? sessionShellComposition.part19 : sessionShellComposition.part20,
                    active ? tabPillActiveStyle : tabPillInactiveStyle,
                  ]).className,
                  'group',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <span {...stylex.props(sessionShellStyles.label2)}>
                  <SidePanelTabIcon kind={tab.kind} />
                </span>
                <span
                  {...stylex.props([
                    sessionShellComposition.part21,
                    tab.closeable && tab.kind === 'diff' && sessionShellComposition.part22,
                  ])}
                >
                  {tab.label}
                </span>
                {tab.closeable ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={copy.closeTab(tab.label)}
                    {...stylex.props([
                      sessionShellComposition.part23,
                      active ? sessionShellComposition.part24 : sessionShellComposition.part25,
                    ])}
                  >
                    <X {...stylex.props(sessionShellStyles.glyph3)} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      {/* The landing keeps every core panel pinned open, so "+" has nothing to add. */}
      <button
        type="button"
        disabled
        aria-label={copy.addPanel}
        {...stylex.props(sessionShellStylesNative.row)}
      >
        <Plus {...stylex.props(sessionShellStyles.glyph)} />
      </button>
      {endSlot ? <div {...stylex.props(sessionShellStyles.row4)}>{endSlot}</div> : null}
    </div>
  );
}

// ---- Composer info bar --------------------------------------------------------

export type ReplicaInfoBarAction = { id: string; label: string };

const infoChipStyle = sessionShellComposition.part30;

function InfoBarActions({
  actions,
  moreActionsLabel,
}: {
  actions: ReplicaInfoBarAction[];
  moreActionsLabel: string;
}) {
  const [primary, ...overflow] = actions;
  if (!primary) return null;
  return (
    <div {...stylex.props(sessionShellStyles.row9)}>
      <button
        type="button"
        tabIndex={-1}
        title={primary.label}
        {...stylex.props(sessionShellStylesNative.row2)}
      >
        <span {...stylex.props(sessionShellStyles.label)}>{primary.label}</span>
      </button>
      {overflow.length > 0 ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={moreActionsLabel}
          title={moreActionsLabel}
          {...stylex.props(sessionShellStylesNative.row3)}
        >
          <ChevronDown {...stylex.props(sessionShellStyles.glyph4)} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export type ReplicaSessionInfoBarProps = {
  projectName: string | null;
  /** `chat` sessions carry no project identity; `local` + `worktree` shows the worktree glyph. */
  projectKind: 'github' | 'local' | 'chat';
  branch: string | null;
  worktree: boolean;
  pr: { number: number; status: ReplicaPrStatus } | null;
  diffStat: { add: number; del: number } | null;
  actions: ReplicaInfoBarAction[];
  /** Emerald Browser chip (a dev server reported a preview candidate). */
  showBrowserAction: boolean;
  locale: ReplicaLocale;
  /** `mobile` = `MobileSessionView`'s bar: lifted over the drawer's edge-back strip, no PR/diff controls. */
  variant: 'desktop' | 'mobile';
};

/**
 * `SessionInfoBar` with only the context item staged (the landing never has a
 * status/goal/schedule item): `[Browser?] │ [PR|location] project · branch ±diff [actions]`.
 */
export function ReplicaSessionInfoBar({
  projectName,
  projectKind,
  branch,
  worktree,
  pr,
  diffStat,
  actions,
  showBrowserAction,
  locale,
  variant,
}: ReplicaSessionInfoBarProps) {
  const copy = SHELL_COPY[locale];
  const isDesktop = variant === 'desktop';
  const project = projectKind === 'chat' ? null : projectName;
  // Mobile drops the branch (`MobileSessionView` passes `branch={null}`).
  const trimmedBranch = isDesktop ? branch?.trim() || '' : '';
  const hasDiff = diffStat != null && diffStat.add + diffStat.del > 0;
  const hasContext = !!pr || !!project || !!trimmedBranch || hasDiff || actions.length > 0;

  // No items and no standalone action: the bar hides and keeps a 4px gap.
  if (!hasContext && !showBrowserAction) {
    return <div aria-hidden="true" {...stylex.props(sessionShellStyles.frame3)} />;
  }

  const locationGlyph =
    projectKind === 'local' && worktree ? (
      <span {...stylex.props(sessionShellStyles.row10)}>
        <WorktreeIcon {...stylex.props(sessionStatus.worktree)} />
      </span>
    ) : null;

  const prFace = pr ? (
    <>
      <ReplicaPrIcon status={pr.status} />
      <span {...stylex.props(sessionShellStyles.label3)}>#{pr.number}</span>
    </>
  ) : null;
  const prControl = pr ? (
    isDesktop ? (
      <button
        type="button"
        tabIndex={-1}
        {...stylex.props(sessionStatus.desktop, REPLICA_PR_STATUS_STYLES[pr.status])}
      >
        {prFace}
      </button>
    ) : (
      <span {...stylex.props(sessionStatus.mobile, REPLICA_PR_STATUS_STYLES[pr.status])}>
        {prFace}
      </span>
    )
  ) : null;

  const iconBadge = prControl ?? locationGlyph ?? (
    <span {...stylex.props(sessionShellStyles.row11)}>
      <GitBranch {...stylex.props(sessionShellStyles.glyph5)} aria-hidden="true" />
    </span>
  );

  const summary = (
    <span {...stylex.props(sessionShellStyles.row12)}>
      {project ? <span {...stylex.props(sessionShellStyles.label4)}>{project}</span> : null}
      {trimmedBranch ? (
        <button type="button" tabIndex={-1} {...stylex.props(sessionShellStylesNative.row4)}>
          <span {...stylex.props(sessionShellStyles.label)}>{trimmedBranch}</span>
        </button>
      ) : null}
      {hasDiff ? (
        <button
          type="button"
          tabIndex={-1}
          disabled={!isDesktop}
          aria-label={copy.allChanges}
          {...stylex.props(sessionShellStylesNative.row5)}
        >
          <span {...stylex.props(sessionShellStyles.label5)}>+{diffStat.add}</span>
          <span {...stylex.props(sessionShellStyles.label6)}>−{diffStat.del}</span>
        </button>
      ) : null}
    </span>
  );

  return (
    <div
      {...stylex.props([
        sessionShellComposition.part28,
        !isDesktop && sessionShellComposition.part29,
      ])}
    >
      <div {...stylex.props(sessionShellStyles.frame4)}>
        <div {...stylex.props(sessionShellStyles.row13)}>
          {showBrowserAction ? (
            // The ghost demo targets `button[aria-label="Browser"]` in every locale.
            <button
              type="button"
              tabIndex={-1}
              aria-label="Browser"
              title={copy.browser}
              {...stylex.props([infoChipStyle, sessionShellComposition.part31])}
            >
              <MonitorPlay {...stylex.props(sessionShellStyles.glyph5)} aria-hidden="true" />
            </button>
          ) : null}
          {hasContext && showBrowserAction ? (
            <span aria-hidden="true" {...stylex.props(sessionShellStyles.surface)} />
          ) : null}
          {hasContext ? (
            <div {...stylex.props(sessionShellStyles.row14)}>
              <div {...stylex.props(sessionShellStyles.row15)}>
                {iconBadge}
                {pr ? locationGlyph : null}
                <span {...stylex.props(sessionShellStyles.row16)}>
                  <span {...stylex.props(sessionShellStyles.label7)}>{summary}</span>
                </span>
                {actions.length ? (
                  <InfoBarActions actions={actions} moreActionsLabel={copy.moreActions} />
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

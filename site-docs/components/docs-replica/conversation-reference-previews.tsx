import * as stylex from '@stylexjs/stylex';
import { ChevronRight, Copy, Folder, PanelRight, Plus, X } from 'lucide-react';
import { ReplicaBrowserToolbar } from '../landing-replica/browser-toolbar';
import { Button } from '../landing-replica/button';
import { ReplicaDiffViewer } from '../landing-replica/changes';
import { ReplicaSendButton } from '../landing-replica/composer';
import {
  ReplicaPermissionModeTrigger,
  ReplicaRunConfigTrigger,
} from '../landing-replica/composer-controls';
import { AgentIcon, FileIcon } from '../landing-replica/icons';
import type { ReplicaChangeFile, ReplicaLocale } from '../landing-replica/types';
const previewStyles = stylex.create({
  text: {
    'margin-left': 'auto',
    'flex-shrink': '0',
    'font-size': '11px',
    color: 'hsl(var(--muted-foreground))',
  },
  row: {
    'margin-left': 'auto',
    display: 'flex',
    'flex-shrink': '0',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'font-family': 'var(--font-mono)',
    'font-size': '11px',
    'font-variant-numeric': 'tabular-nums',
  },
  text2: {
    color: 'hsl(var(--code-added))',
  },
  text3: {
    color: 'hsl(var(--code-removed))',
  },
  frame: {
    width: '100%',
    'text-align': 'left',
  },
  section: {
    overflow: 'hidden',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--background))',
  },
  row2: {
    display: 'flex',
    'min-height': 'calc(var(--spacing) * 8)',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 3)',
    'background-color': 'color-mix(in oklab, hsl(var(--muted)) 30%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 2.5)',
    'padding-block': 'calc(var(--spacing) * 1.5)',
  },
  text4: {
    'min-width': '0px',
    flex: '1',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-medium)',
    color: 'color-mix(in oklab, hsl(var(--foreground)) 80%, transparent)',
  },
  row3: {
    display: 'flex',
    'flex-shrink': '0',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'font-family': 'var(--font-mono)',
    'font-size': '11px',
    'font-variant-numeric': 'tabular-nums',
  },
  section2: {
    ':is(*) > :not(:last-child)': {
      'border-bottom-style': 'solid',
      'border-top-style': 'solid',
      'border-top-width': 'calc(1px * 0)',
      'border-bottom-width': 'calc(1px * calc(1 - 0))',
      'border-color': 'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
    },
  },
  section3: {
    'border-top-style': 'solid',
    'border-top-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
  },
  row4: {
    display: 'flex',
    width: '100%',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'padding-inline': 'calc(var(--spacing) * 2.5)',
    'text-align': 'left',
  },
  section4: {
    'min-height': 'calc(var(--spacing) * 10)',
    'padding-block': 'calc(var(--spacing) * 2)',
  },
  section5: {
    'min-height': 'calc(var(--spacing) * 9)',
    'padding-block': 'calc(var(--spacing) * 1.5)',
  },
  text5: {
    'min-width': '0px',
    flex: '1',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': 'var(--text-sm)',
    'line-height': 'calc(var(--spacing) * 6)',
  },
  text6: {
    color: 'color-mix(in oklab, hsl(var(--foreground)) 90%, transparent)',
  },
  text7: {
    'margin-left': 'calc(var(--spacing) * 1.5)',
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 70%, transparent)',
  },
  section6: {
    'margin-block': 'calc(var(--spacing) * 6)',
  },
  text8: {
    overflow: 'hidden',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--background))',
    padding: 'calc(var(--spacing) * 4)',
    color: 'hsl(var(--foreground))',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-sm)',
    '@media (width >= 40rem)': {
      padding: 'calc(var(--spacing) * 5)',
    },
  },
  row5: {
    display: 'flex',
    'align-items': 'flex-start',
    gap: 'calc(var(--spacing) * 3)',
  },
  row6: {
    'margin-top': 'calc(var(--spacing) * 0.5)',
    display: 'flex',
    height: 'calc(var(--spacing) * 7)',
    width: 'calc(var(--spacing) * 7)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
    'border-radius': 'calc(infinity * 1px)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'color-mix(in oklab, hsl(var(--muted)) 50%, transparent)',
  },
  section7: {
    'min-width': '0px',
    flex: '1',
  },
  row7: {
    'margin-bottom': 'calc(var(--spacing) * 2)',
    display: 'flex',
    'flex-wrap': 'wrap',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'font-size': '11px',
    color: 'hsl(var(--muted-foreground))',
  },
  section8: {
    'font-weight': 'var(--font-weight-medium)',
  },
  section9: {
    'font-variant-numeric': 'tabular-nums',
  },
  text9: {
    'max-width': '760px',
    'border-radius': 'var(--radius-2xl)',
    'border-top-left-radius': 'var(--radius-sm)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--card))',
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-block': 'calc(var(--spacing) * 3)',
    'font-size': 'var(--text-sm)',
    'line-height': 'calc(var(--spacing) * 6)',
    color: 'hsl(var(--card-foreground))',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-sm)',
  },
  section10: {
    'margin-top': 'calc(var(--spacing) * 2.5)',
    'max-width': '760px',
  },
  text10: {
    overflow: 'hidden',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--background))',
    padding: 'calc(var(--spacing) * 3)',
    color: 'hsl(var(--foreground))',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-sm)',
    '@media (width >= 40rem)': {
      padding: 'calc(var(--spacing) * 4)',
    },
  },
  overlay: {
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
  section11: {
    display: 'none',
    ':where(.dark, .dark *)': {
      display: 'block',
    },
  },
  section12: {
    ':where(.dark, .dark *)': {
      display: 'none',
    },
  },
  row8: {
    display: 'flex',
    height: '22px',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'border-radius': 'var(--radius-md)',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'font-size': '13px',
    color: 'color-mix(in oklab, hsl(var(--foreground)) 90%, transparent)',
  },
  text11: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    'flex-shrink': '0',
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 70%, transparent)',
  },
  text12: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    'flex-shrink': '0',
    color: 'hsl(var(--muted-foreground))',
  },
  section13: {
    'min-width': '0px',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  },
  frame2: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    'flex-shrink': '0',
  },
  section14: {
    'min-width': '0px',
    flex: '1',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  },
  text13: {
    'flex-shrink': '0',
    'font-size': '10px',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': 'var(--tracking-wide)',
    color: 'hsl(var(--primary))',
    'text-transform': 'uppercase',
  },
  text14: {
    'margin-inline': 'auto',
    width: '100%',
    'max-width': '320px',
    overflow: 'hidden',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-sm)',
  },
  row9: {
    display: 'flex',
    height: 'calc(var(--spacing) * 10)',
    'flex-shrink': '0',
    'align-items': 'center',
    gap: 'var(--spacing)',
    'border-bottom-style': 'solid',
    'border-bottom-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border)) 60%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 2)',
  },
  row10: {
    display: 'inline-flex',
    height: 'calc(var(--spacing) * 6)',
    'align-items': 'center',
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border)) 60%, transparent)',
    'background-color': 'color-mix(in oklab, hsl(var(--muted)) 40%, transparent)',
    padding: 'calc(var(--spacing) * 0.5)',
    'font-size': '11px',
  },
  row11: {
    display: 'flex',
    height: 'calc(var(--spacing) * 5)',
    'align-items': 'center',
    'border-radius': '0.25rem',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'font-weight': 'var(--font-weight-medium)',
    color: 'hsl(var(--foreground))',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-sm)',
  },
  row12: {
    display: 'flex',
    height: 'calc(var(--spacing) * 5)',
    'align-items': 'center',
    'border-radius': '0.25rem',
    'padding-inline': 'calc(var(--spacing) * 2)',
    color: 'hsl(var(--muted-foreground))',
  },
  section15: {
    padding: 'calc(var(--spacing) * 1.5)',
  },
  stack: {
    display: 'flex',
    'flex-direction': 'column',
    gap: '1px',
  },
  row13: {
    'margin-block': 'calc(var(--spacing) * 6)',
    display: 'flex',
    'justify-content': 'center',
  },
  text15: {
    width: '100%',
    'max-width': '560px',
    color: 'hsl(var(--foreground))',
    '--composer': 'var(--muted)',
  },
  stack2: {
    'container-type': 'inline-size',
    'container-name': 'composer-box',
    display: 'flex',
    'flex-direction': 'column',
    gap: 'var(--spacing)',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--foreground)) 10%, transparent)',
    'background-color': 'hsl(var(--composer))',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'calc(var(--spacing) * 1.5)',
    'box-shadow':
      '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 3px 6px -2px lch(0% 0 0/0.02), 0 1px 1px lch(0% 0 0/0.04)',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': '150ms',
    '--mention-chip-surface': 'hsl(var(--composer))',
    ':where(.dark, .dark *)': {
      'border-color': 'color-mix(in oklab, hsl(var(--input-border)) 70%, transparent)',
      'background-color': 'color-mix(in oklab, hsl(var(--input)) 90%, transparent)',
      'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000',
    },
  },
  row14: {
    display: 'flex',
    gap: 'calc(var(--spacing) * 2)',
    'overflow-x': 'auto',
    'padding-bottom': 'var(--spacing)',
  },
  frame3: {
    position: 'relative',
    height: 'calc(var(--spacing) * 20)',
    width: 'calc(var(--spacing) * 20)',
    'flex-shrink': '0',
    overflow: 'hidden',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
  },
  frame4: {
    height: '100%',
    width: '100%',
    'object-fit': 'cover',
  },
  text16: {
    'min-height': 'calc(var(--spacing) * 12)',
    'padding-inline': 'var(--spacing)',
    'padding-top': 'var(--spacing)',
    'font-size': 'var(--text-sm)',
    'line-height': 'calc(var(--spacing) * 6)',
    color: 'hsl(var(--input-foreground))',
  },
  row15: {
    display: 'flex',
    'align-items': 'center',
    gap: 'var(--spacing)',
    'padding-top': 'calc(var(--spacing) * 0.5)',
  },
  row16: {
    'container-type': 'inline-size',
    'container-name': 'composer-face',
    display: 'flex',
    'min-width': '0px',
    flex: '1',
    'flex-wrap': 'nowrap',
    'align-items': 'center',
    'column-gap': 'calc(var(--spacing) * 1.5)',
    overflow: 'hidden',
  },
  stack3: {
    display: 'inline-flex',
    'max-width': '100%',
    'flex-direction': 'column',
    overflow: 'hidden',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
    'background-color': 'color-mix(in oklab, hsl(var(--muted)) 20%, transparent)',
  },
  row17: {
    display: 'inline-flex',
    'max-width': '100%',
  },
  section16: {
    display: 'block',
    'max-height': '280px',
    'max-width': '100%',
    'object-fit': 'contain',
  },
  row18: {
    'margin-top': 'calc(var(--spacing) * 2)',
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'font-size': '11px',
    color: 'hsl(var(--muted-foreground))',
  },
  frame5: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
  },
  text17: {
    overflow: 'hidden',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-sm)',
  },
  text18: {
    position: 'relative',
    'min-height': '310px',
    overflow: 'hidden',
    'background-image': 'linear-gradient(160deg,#071a2c 0%,#03090f 78%,#02060b 100%)',
    'padding-inline': 'calc(var(--spacing) * 5)',
    'padding-block': 'calc(var(--spacing) * 5)',
    color: 'var(--color-slate-100)',
    '@media (width >= 40rem)': {
      'padding-inline': 'calc(var(--spacing) * 8)',
    },
  },
  row19: {
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'space-between',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
  },
  row20: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': 'var(--tracking-wide)',
  },
  row21: {
    display: 'flex',
    height: 'calc(var(--spacing) * 6)',
    width: 'calc(var(--spacing) * 6)',
    'align-items': 'center',
    'justify-content': 'center',
    'border-radius': 'var(--radius-lg)',
    'background-color': 'var(--color-sky-400)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    color: 'var(--color-slate-950)',
  },
  text19: {
    display: 'none',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 3)',
    color: 'color-mix(in oklab, var(--color-slate-300) 90%, transparent)',
    '@media (width >= 40rem)': {
      display: 'flex',
    },
  },
  section17: {
    'margin-inline': 'auto',
    'margin-top': 'calc(var(--spacing) * 10)',
    'max-width': '360px',
    'text-align': 'center',
  },
  section18: {
    position: 'relative',
    display: 'inline-block',
  },
  text20: {
    'font-size': 'var(--text-2xl)',
    'line-height': 'var(--leading-tight)',
    'font-weight': 'var(--font-weight-bold)',
    'letter-spacing': 'var(--tracking-tight)',
    'text-wrap': 'balance',
    color: 'var(--color-white)',
    '@media (width >= 40rem)': {
      'font-size': 'var(--text-3xl)',
      'line-height': 'var(--leading-tight)',
    },
  },
  overlay2: {
    'pointer-events': 'none',
    position: 'absolute',
    inset: 'calc(var(--spacing) * -2)',
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '2px',
    'border-color': 'rgba(37,99,235,0.9)',
    'background-color': 'rgba(37,99,235,0.08)',
  },
  text21: {
    'margin-top': 'calc(var(--spacing) * 4)',
    'font-size': 'var(--text-sm)',
    'line-height': 'calc(var(--spacing) * 6)',
    color: 'var(--color-slate-300)',
  },
  row22: {
    'margin-top': 'calc(var(--spacing) * 5)',
    display: 'flex',
    'justify-content': 'center',
    gap: 'calc(var(--spacing) * 2)',
  },
  text22: {
    'border-radius': 'var(--radius-lg)',
    'background-color': 'var(--color-sky-400)',
    'padding-inline': 'calc(var(--spacing) * 3.5)',
    'padding-block': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    color: 'var(--color-slate-950)',
  },
  text23: {
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, var(--color-slate-500) 60%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 3.5)',
    'padding-block': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-medium)',
    color: 'var(--color-slate-200)',
  },
  overlay3: {
    position: 'absolute',
    right: 'calc(var(--spacing) * 4)',
    bottom: 'calc(var(--spacing) * 4)',
    'z-index': '10',
    width: 'min(240px, calc(100% - 2rem))',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--popover))',
    padding: 'calc(var(--spacing) * 3)',
    'text-align': 'left',
    color: 'hsl(var(--popover-foreground))',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 25px 50px -12px rgb(0 0 0 / 0.25)',
  },
  row23: {
    'margin-bottom': 'calc(var(--spacing) * 2)',
    display: 'flex',
    'align-items': 'flex-start',
    gap: 'calc(var(--spacing) * 2)',
  },
  text24: {
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
  },
  text25: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-family': 'var(--font-mono)',
    'font-size': '10px',
    color: 'hsl(var(--muted-foreground))',
  },
  row24: {
    display: 'inline-flex',
    height: 'calc(var(--spacing) * 6)',
    width: 'calc(var(--spacing) * 6)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
    'border-radius': 'var(--radius-md)',
    color: 'hsl(var(--muted-foreground))',
    '@media (hover: hover)': {
      ':hover': {
        'background-color': 'hsl(var(--hover))',
        color: 'hsl(var(--hover-foreground))',
      },
    },
  },
  text26: {
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--input-border))',
    'background-color': 'hsl(var(--background))',
    'padding-inline': 'calc(var(--spacing) * 2.5)',
    'padding-block': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground))',
  },
  row25: {
    'margin-top': 'calc(var(--spacing) * 2)',
    display: 'flex',
    'justify-content': 'flex-end',
    gap: 'calc(var(--spacing) * 1.5)',
  },
});

const buttonStyles = stylex.create({
  glyph: { height: 'calc(var(--spacing) * 4)', width: 'calc(var(--spacing) * 4)' },
  collapse: {
    marginLeft: 'auto',
    height: 'calc(var(--spacing) * 6)',
    width: 'calc(var(--spacing) * 6)',
    color: 'hsl(var(--muted-foreground))',
  },
  removeImage: {
    position: 'absolute',
    right: 'calc(var(--spacing) * 1)',
    top: 'calc(var(--spacing) * 1)',
    height: 'calc(var(--spacing) * 5)',
    width: 'calc(var(--spacing) * 5)',
    minWidth: 0,
    borderRadius: 'var(--radius-md)',
    padding: 0,
    color: 'hsl(var(--foreground))',
  },
  attach: {
    height: 'calc(var(--spacing) * 7)',
    width: 'calc(var(--spacing) * 7)',
    flexShrink: 0,
    color: 'hsl(var(--muted-foreground))',
  },
  comment: {
    height: 'calc(var(--spacing) * 7)',
    paddingInline: 'calc(var(--spacing) * 2)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
  },
});

/* Display-only docs previews for the conversation reference pages. They copy
   the current app's markup and tokens (`assistant-edited-files.tsx`,
   `ui/diff-viewer/diff-viewer.tsx`, `sessions/session-changes-sidebar.tsx`,
   `sessions/components/file-tree-view.tsx`, `chat/chat-composer.tsx`,
   `ai-gui/view.tsx`, and `sessions/session-browser-panel.tsx`) but never import
   the app. Screenshot-like attachments are inline SVG data URIs; the image-output
   sample points at the tracked brand mark (`/_docs-assets/logo-180.png`) so it
   never ships a captured product screenshot. */

const svgDataUri = (markup: string): string =>
  `data:image/svg+xml;utf8,${encodeURIComponent(markup)}`;

const ATTACHMENT_PREVIEW_IMAGE = svgDataUri(`
<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320" fill="none">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="320" y2="320" gradientUnits="userSpaceOnUse">
      <stop stop-color="#111b31" />
      <stop offset="1" stop-color="#050912" />
    </linearGradient>
  </defs>
  <rect width="320" height="320" rx="36" fill="url(#bg)" />
  <rect x="30" y="48" width="260" height="56" rx="14" fill="#1a2742" stroke="#2b3c5f" />
  <text x="48" y="82" fill="#9db2d3" font-family="ui-sans-serif, system-ui, sans-serif" font-size="18">Configuration Type</text>
  <rect x="30" y="118" width="260" height="48" rx="14" fill="#1b2740" stroke="#31486f" />
  <text x="48" y="148" fill="#dbeafe" font-family="ui-sans-serif, system-ui, sans-serif" font-size="20">Claude</text>
  <text x="268" y="149" fill="#93c5fd" font-family="ui-sans-serif, system-ui, sans-serif" font-size="17" text-anchor="end">⌄</text>
  <rect x="30" y="180" width="260" height="92" rx="14" fill="#121d33" stroke="#2b3c5f" />
  <rect x="38" y="188" width="244" height="34" rx="10" fill="#223354" />
  <text x="52" y="210" fill="#eff6ff" font-family="ui-sans-serif, system-ui, sans-serif" font-size="18">Claude</text>
  <text x="272" y="211" fill="#93c5fd" font-family="ui-sans-serif, system-ui, sans-serif" font-size="16" text-anchor="end">✓</text>
  <text x="52" y="252" fill="#c7d2fe" font-family="ui-sans-serif, system-ui, sans-serif" font-size="18">Codex</text>
</svg>
`);

type SummaryFile = {
  filePath: string;
  add: number;
  del: number;
};

const FILE_SUMMARY_COPY: Record<
  ReplicaLocale,
  { summary: (count: number) => string; changed: string }
> = {
  en: {
    summary: (count) => `Edited ${count} files`,
    changed: 'Changed',
  },
  zh: {
    summary: (count) => `编辑了 ${count} 个文件`,
    changed: '已更改',
  },
};

const CONVERSATION_DIFF_COPY: Record<ReplicaLocale, { finished: string; assistantText: string }> = {
  en: {
    finished: 'Finished working',
    assistantText:
      'Implemented the requested changes and ran the test suite. The landing composer now keeps attached images while switching models.',
  },
  zh: {
    finished: '已完成工作',
    assistantText: '已完成修改并运行了测试。切换模型时，首页输入框会保留已附加的图片。',
  },
};

const CONVERSATION_DIFF_FILES: readonly SummaryFile[] = [
  {
    filePath: 'packages/components/src/components/chat/chat-landing-view.tsx',
    add: 5,
    del: 0,
  },
  {
    filePath: 'packages/components/src/components/chat/chat-landing.tsx',
    add: 16,
    del: 0,
  },
  {
    filePath: 'packages/components/src/components/chat/local-project-chat-landing.tsx',
    add: 16,
    del: 0,
  },
  {
    filePath: 'packages/shared/src/agent-config-setting.ts',
    add: 1,
    del: 215,
  },
];

function splitFilePath(filePath: string): { directory: string; name: string } {
  const normalized = filePath.replace(/\\/g, '/');
  const separatorIndex = normalized.lastIndexOf('/');
  if (separatorIndex === -1) return { directory: '', name: normalized };
  return {
    directory: normalized.slice(0, separatorIndex),
    name: normalized.slice(separatorIndex + 1),
  };
}

function SummaryStats({ add, del, locale }: { add: number; del: number; locale: ReplicaLocale }) {
  const copy = FILE_SUMMARY_COPY[locale];
  if (add === 0 && del === 0) {
    return <span {...stylex.props(previewStyles.text)}>{copy.changed}</span>;
  }

  return (
    <span {...stylex.props(previewStyles.row)}>
      <span {...stylex.props(previewStyles.text2)}>+{add}</span>
      <span {...stylex.props(previewStyles.text3)}>-{del}</span>
    </span>
  );
}

function AssistantEditedFilesSummary({
  files,
  locale,
}: {
  files: readonly SummaryFile[];
  locale: ReplicaLocale;
}) {
  const copy = FILE_SUMMARY_COPY[locale];
  const totals = files.reduce(
    (result, file) => ({ add: result.add + file.add, del: result.del + file.del }),
    { add: 0, del: 0 }
  );
  const isSingleFile = files.length === 1;

  return (
    <div {...stylex.props(previewStyles.frame)}>
      <div {...stylex.props(previewStyles.section)}>
        {!isSingleFile ? (
          <div {...stylex.props(previewStyles.row2)}>
            <span {...stylex.props(previewStyles.text4)}>{copy.summary(files.length)}</span>
            <span {...stylex.props(previewStyles.row3)}>
              <span {...stylex.props(previewStyles.text2)}>+{totals.add}</span>
              <span {...stylex.props(previewStyles.text3)}>-{totals.del}</span>
            </span>
          </div>
        ) : null}
        <div {...stylex.props(previewStyles.section2, !isSingleFile && previewStyles.section3)}>
          {files.map((file) => {
            const { directory, name } = splitFilePath(file.filePath);
            return (
              <div
                key={file.filePath}
                {...stylex.props(
                  previewStyles.row4,
                  isSingleFile ? previewStyles.section4 : previewStyles.section5
                )}
                title={file.filePath}
              >
                <span {...stylex.props(previewStyles.text5)}>
                  <span {...stylex.props(previewStyles.text6)}>{name}</span>
                  {directory ? (
                    <span {...stylex.props(previewStyles.text7)}>{directory}</span>
                  ) : null}
                </span>
                <SummaryStats add={file.add} del={file.del} locale={locale} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function ConversationDiffPreview({ locale = 'en' }: { locale?: ReplicaLocale }) {
  const copy = CONVERSATION_DIFF_COPY[locale];

  return (
    <div {...stylex.props(previewStyles.section6)}>
      <div
        aria-hidden="true"
        className={['lody-app-preview', stylex.props(previewStyles.text8).className].join(' ')}
      >
        <div {...stylex.props(previewStyles.row5)}>
          <span {...stylex.props(previewStyles.row6)}>
            <AgentIcon agent="codex" xstyle={buttonStyles.glyph} />
          </span>
          <div {...stylex.props(previewStyles.section7)}>
            <div {...stylex.props(previewStyles.row7)}>
              <span {...stylex.props(previewStyles.section8)}>{copy.finished}</span>
              <span aria-hidden="true">·</span>
              <span {...stylex.props(previewStyles.section9)}>11m 19s</span>
            </div>
            <div {...stylex.props(previewStyles.text9)}>{copy.assistantText}</div>
            <div {...stylex.props(previewStyles.section10)}>
              <AssistantEditedFilesSummary files={CONVERSATION_DIFF_FILES} locale={locale} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* Source: packages/components/src/ui/diff-viewer/diff-viewer.tsx and
   DiffViewer.stories.tsx. The landing replica already carries the production
   card chrome and Pierre theme wiring, so the docs preview only supplies a
   synthetic file. Two hidden variants follow the reader's light/dark theme:
   @pierre/diffs needs an explicit theme type, which cannot be read from CSS. */
const DIFF_PREVIEW_FILE: ReplicaChangeFile = {
  path: 'apps/cli/src/lib/local-probe.ts',
  add: 2,
  del: 1,
  oldText: [
    "import * as http from 'http';",
    "import * as os from 'os';",
    "import type { MachineId } from './ids';",
    "import { LOCAL_PROBE_PORT } from './local-probe';",
    "import type { Logger } from './logger';",
    '',
    'const ALLOWED_ORIGINS = new Set([',
    "  'https://lody.ai',",
    ']);',
    '',
  ].join('\n'),
  newText: [
    "import * as http from 'http';",
    "import * as os from 'os';",
    "import type { MachineId } from './ids';",
    "import { LOCAL_PROBE_PORT } from './local-probe';",
    "import type { Logger } from './logger';",
    '',
    'const ALLOWED_ORIGINS = new Set([',
    "  'https://lody.ai',",
    "  'https://app.lody.ai',",
    ']);',
    '',
  ].join('\n'),
};

export function DiffViewerPreview({ locale = 'en' }: { locale?: ReplicaLocale }) {
  return (
    <div {...stylex.props(previewStyles.section6)}>
      <div
        aria-hidden="true"
        className={['lody-app-preview', stylex.props(previewStyles.text10).className].join(' ')}
      >
        <span {...stylex.props(previewStyles.overlay)}>
          {locale === 'zh' ? '差异查看器预览' : 'Diff viewer preview'}
        </span>
        <div {...stylex.props(previewStyles.section11)}>
          <ReplicaDiffViewer file={DIFF_PREVIEW_FILE} dark />
        </div>
        <div {...stylex.props(previewStyles.section12)}>
          <ReplicaDiffViewer file={DIFF_PREVIEW_FILE} dark={false} />
        </div>
      </div>
    </div>
  );
}

type FolderTreeEntry = {
  name: string;
  kind: 'folder';
};

type FileTreeEntry = {
  name: string;
  kind: 'file';
  modified?: boolean;
};

type TreeEntry = FolderTreeEntry | FileTreeEntry;

const SESSION_TREE_COPY: Record<
  ReplicaLocale,
  { files: string; changes: string; modified: string }
> = {
  en: { files: 'Files', changes: 'Changes', modified: 'Modified in this conversation' },
  zh: { files: '文件', changes: '变更', modified: '当前对话中已修改' },
};

// Short synthetic root from the SessionChangesSidebar / FileTreeList stories.
// All folders stay collapsed; this is a display-only still, not a tree control.
const SESSION_TREE_ENTRIES: readonly TreeEntry[] = [
  { name: 'apps', kind: 'folder' },
  { name: 'backend', kind: 'folder' },
  { name: 'docs', kind: 'folder' },
  { name: 'functions', kind: 'folder' },
  { name: 'locales', kind: 'folder' },
  { name: 'packages', kind: 'folder' },
  { name: 'scripts', kind: 'folder' },
  { name: 'specs', kind: 'folder' },
  { name: 'AGENTS.md', kind: 'file', modified: true },
  { name: 'CHANGELOG.md', kind: 'file', modified: true },
  { name: 'CLAUDE.md', kind: 'file' },
  { name: 'conductor.json', kind: 'file' },
  { name: 'DEV.md', kind: 'file', modified: true },
  { name: 'package.json', kind: 'file' },
  { name: 'pnpm-lock.yaml', kind: 'file' },
  { name: 'pnpm-workspace.yaml', kind: 'file' },
  { name: 'README.md', kind: 'file', modified: true },
  { name: 'release-please-config.json', kind: 'file' },
];

function FolderTreeRow({ name }: { name: string }) {
  return (
    <div role="treeitem" aria-expanded={false} {...stylex.props(previewStyles.row8)}>
      <ChevronRight {...stylex.props(previewStyles.text11)} aria-hidden="true" />
      <Folder {...stylex.props(previewStyles.text12)} aria-hidden="true" />
      <span {...stylex.props(previewStyles.section13)}>{name}</span>
    </div>
  );
}

function FileTreeRow({ entry, locale }: { entry: FileTreeEntry; locale: ReplicaLocale }) {
  const copy = SESSION_TREE_COPY[locale];
  return (
    <div
      role="treeitem"
      title={entry.modified ? copy.modified : entry.name}
      {...stylex.props(previewStyles.row8)}
    >
      <span {...stylex.props(previewStyles.frame2)} aria-hidden="true" />
      <FileIcon path={entry.name} xstyle={buttonStyles.glyph} />
      <span {...stylex.props(previewStyles.section14)}>{entry.name}</span>
      {entry.modified ? <span {...stylex.props(previewStyles.text13)}>M±</span> : null}
    </div>
  );
}

export function SessionFilesPreview({ locale = 'en' }: { locale?: ReplicaLocale }) {
  const copy = SESSION_TREE_COPY[locale];

  return (
    <div {...stylex.props(previewStyles.section6)}>
      <div
        aria-hidden="true"
        className={['lody-app-preview', stylex.props(previewStyles.text14).className].join(' ')}
      >
        <div {...stylex.props(previewStyles.row9)}>
          <div {...stylex.props(previewStyles.row10)}>
            <span {...stylex.props(previewStyles.row11)}>{copy.files}</span>
            <span {...stylex.props(previewStyles.row12)}>{copy.changes}</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={locale === 'zh' ? '收起侧边栏' : 'Collapse sidebar'}
            xstyle={buttonStyles.collapse}
            iconSize="calc(var(--spacing) * 3.5)"
          >
            <PanelRight />
          </Button>
        </div>
        <div role="tree" {...stylex.props(previewStyles.section15)}>
          <div {...stylex.props(previewStyles.stack)}>
            {SESSION_TREE_ENTRIES.map((entry) =>
              entry.kind === 'folder' ? (
                <FolderTreeRow key={entry.name} name={entry.name} />
              ) : (
                <FileTreeRow key={entry.name} entry={entry} locale={locale} />
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const IMAGE_INPUT_COPY: Record<
  ReplicaLocale,
  {
    attachmentAlt: string;
    removeImage: string;
    addAttachment: string;
    permission: string;
    prompt: string;
  }
> = {
  en: {
    attachmentAlt: 'Synthetic screenshot of a Configuration Type dropdown',
    removeImage: 'Remove image',
    addAttachment: 'Add attachment',
    permission: 'Agent (full access)',
    prompt: "What's in this image?",
  },
  zh: {
    attachmentAlt: '配置类型下拉框的模拟截图',
    removeImage: '移除图片',
    addAttachment: '添加附件',
    permission: 'Agent（完全访问）',
    prompt: '图片里是什么？',
  },
};

export function ImageInputPreview({ locale = 'en' }: { locale?: ReplicaLocale }) {
  const copy = IMAGE_INPUT_COPY[locale];

  return (
    <div {...stylex.props(previewStyles.row13)}>
      <div
        aria-hidden="true"
        className={['lody-app-preview', stylex.props(previewStyles.text15).className].join(' ')}
      >
        <div {...stylex.props(previewStyles.stack2)}>
          <div
            className={['input-scrollbar', stylex.props(previewStyles.row14).className].join(' ')}
          >
            <div {...stylex.props(previewStyles.frame3)}>
              <img
                src={ATTACHMENT_PREVIEW_IMAGE}
                alt={copy.attachmentAlt}
                {...stylex.props(previewStyles.frame4)}
              />
              <Button
                type="button"
                variant="secondary"
                size="icon"
                aria-label={copy.removeImage}
                xstyle={buttonStyles.removeImage}
                iconSize="calc(var(--spacing) * 3)"
                shadow="sm"
              >
                <X />
              </Button>
            </div>
          </div>
          <div {...stylex.props(previewStyles.text16)}>{copy.prompt}</div>
          <div {...stylex.props(previewStyles.row15)}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={copy.addAttachment}
              xstyle={buttonStyles.attach}
            >
              <Plus strokeWidth={1.5} />
            </Button>
            <div {...stylex.props(previewStyles.row16)}>
              <ReplicaRunConfigTrigger agent="codex" modelLabel="5.4" thinkLabel="Medium" />
              <ReplicaPermissionModeTrigger label={copy.permission} />
            </div>
            <ReplicaSendButton variant="session" disabled={false} />
          </div>
        </div>
      </div>
    </div>
  );
}

const IMAGE_OUTPUT_COPY: Record<
  ReplicaLocale,
  { alt: string; metadata: string; duration: string }
> = {
  en: {
    alt: 'Lody logo used as the generated-image sample',
    metadata: 'Generated with gpt-5.4',
    duration: '21m 14s',
  },
  zh: {
    alt: '作为生成图片示例的 Lody 标志',
    metadata: '由 gpt-5.4 生成',
    duration: '21m 14s',
  },
};

export function ImageOutputPreview({ locale = 'en' }: { locale?: ReplicaLocale }) {
  const copy = IMAGE_OUTPUT_COPY[locale];

  return (
    <div {...stylex.props(previewStyles.section6)}>
      <div
        aria-hidden="true"
        className={['lody-app-preview', stylex.props(previewStyles.text8).className].join(' ')}
      >
        <div {...stylex.props(previewStyles.row5)}>
          <span {...stylex.props(previewStyles.row6)}>
            <AgentIcon agent="codex" xstyle={buttonStyles.glyph} />
          </span>
          <div {...stylex.props(previewStyles.section7)}>
            <div {...stylex.props(previewStyles.row7)}>
              <span {...stylex.props(previewStyles.section9)}>2026/5/6 12:55</span>
              <span aria-hidden="true">·</span>
              <span>{copy.metadata}</span>
            </div>
            <div {...stylex.props(previewStyles.stack3)}>
              <div {...stylex.props(previewStyles.row17)}>
                {/* Use the tracked brand mark instead of a synthetic screenshot as the
                    representative generated image. */}
                <img
                  src="/_docs-assets/logo-180.png"
                  alt={copy.alt}
                  width={180}
                  height={180}
                  {...stylex.props(previewStyles.section16)}
                />
              </div>
            </div>
            <div {...stylex.props(previewStyles.row18)}>
              <Copy {...stylex.props(previewStyles.frame5)} aria-hidden="true" />
              <span {...stylex.props(previewStyles.section9)}>{copy.duration}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const BROWSER_COPY: Record<
  ReplicaLocale,
  {
    heading: string;
    body: string;
    getStarted: string;
    viewDocs: string;
    commentTitle: string;
    commentTarget: string;
    commentBody: string;
    cancel: string;
    addComment: string;
  }
> = {
  en: {
    heading: 'Run your agents from anywhere',
    body: 'Start work on one machine, then keep it moving from desktop, tablet, or phone.',
    getStarted: 'Get started',
    viewDocs: 'View docs',
    commentTitle: 'Preview comment',
    commentTarget: 'h2 "Run your agents from anywhere"',
    commentBody: 'Tighten the spacing above the primary action.',
    cancel: 'Cancel',
    addComment: 'Add comment',
  },
  zh: {
    heading: '随处运行你的 Agent',
    body: '在一台机器上开始工作，然后在桌面、平板或手机上继续推进。',
    getStarted: '开始使用',
    viewDocs: '查看文档',
    commentTitle: '预览评论',
    commentTarget: 'h2 “随处运行你的 Agent”',
    commentBody: '收紧主操作按钮上方的间距。',
    cancel: '取消',
    addComment: '添加评论',
  },
};

export function BrowserPreview({ locale = 'en' }: { locale?: ReplicaLocale }) {
  const copy = BROWSER_COPY[locale];

  return (
    <div {...stylex.props(previewStyles.section6)}>
      <div
        aria-hidden="true"
        className={['lody-app-preview', stylex.props(previewStyles.text17).className].join(' ')}
      >
        <ReplicaBrowserToolbar
          address="http://127.0.0.1:5173/dashboard"
          loading={false}
          annotating
          locale={locale}
        />
        <div {...stylex.props(previewStyles.text18)}>
          <div {...stylex.props(previewStyles.row19)}>
            <span {...stylex.props(previewStyles.row20)}>
              <span {...stylex.props(previewStyles.row21)}>L</span>
              Lody
            </span>
            <span {...stylex.props(previewStyles.text19)}>
              <span>{copy.viewDocs}</span>
              <span>{copy.getStarted}</span>
            </span>
          </div>
          <div {...stylex.props(previewStyles.section17)}>
            <div {...stylex.props(previewStyles.section18)}>
              <h2 {...stylex.props(previewStyles.text20)}>{copy.heading}</h2>
              <span aria-hidden="true" {...stylex.props(previewStyles.overlay2)} />
            </div>
            <p {...stylex.props(previewStyles.text21)}>{copy.body}</p>
            <div {...stylex.props(previewStyles.row22)}>
              <span {...stylex.props(previewStyles.text22)}>{copy.getStarted}</span>
              <span {...stylex.props(previewStyles.text23)}>{copy.viewDocs}</span>
            </div>
          </div>
          <div {...stylex.props(previewStyles.overlay3)}>
            <div {...stylex.props(previewStyles.row23)}>
              <div {...stylex.props(previewStyles.section7)}>
                <div {...stylex.props(previewStyles.text24)}>{copy.commentTitle}</div>
                <div {...stylex.props(previewStyles.text25)}>{copy.commentTarget}</div>
              </div>
              <button type="button" aria-label={copy.cancel} {...stylex.props(previewStyles.row24)}>
                <X {...stylex.props(previewStyles.frame5)} />
              </button>
            </div>
            <div {...stylex.props(previewStyles.text26)}>{copy.commentBody}</div>
            <div {...stylex.props(previewStyles.row25)}>
              <Button type="button" variant="ghost" size="sm" xstyle={buttonStyles.comment}>
                {copy.cancel}
              </Button>
              <Button type="button" variant="default" size="sm" xstyle={buttonStyles.comment}>
                {copy.addComment}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

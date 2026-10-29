import * as React from 'react';
import { GripVerticalIcon } from 'lucide-react';
import * as ResizablePrimitive from 'react-resizable-panels';
import * as stylex from '@stylexjs/stylex';

import { withClassName } from '@/lib/stylex';
import { themeColors } from '../style/theme-colors.stylex';
import { themeRadius, themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  group: {
    display: 'flex',
    height: '100%',
    width: '100%',
    flexDirection: { default: null, ':is([data-panel-group-direction="vertical"])': 'column' },
  },
  handle: {
    backgroundColor: themeColors.border,
    position: 'relative',
    display: 'flex',
    width: { default: '1px', ':is([data-panel-group-direction="vertical"])': '100%' },
    height: { default: null, ':is([data-panel-group-direction="vertical"])': '1px' },
    alignItems: 'center',
    justifyContent: 'center',
    '--tw-ring-color': { default: null, ':focus-visible': themeColors.ring },
    '--tw-ring-offset-width': { default: null, ':focus-visible': '1px' },
    '--tw-ring-offset-shadow': {
      default: null,
      ':focus-visible':
        'var(--tw-ring-inset,) 0 0 0 var(--tw-ring-offset-width) var(--tw-ring-offset-color)',
    },
    '--tw-ring-shadow': {
      default: null,
      ':focus-visible':
        'var(--tw-ring-inset,) 0 0 0 calc(1px + var(--tw-ring-offset-width)) var(--tw-ring-color, currentcolor)',
    },
    boxShadow: {
      default: null,
      ':focus-visible':
        'var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)',
    },
    outlineStyle: { default: null, ':focus-visible': 'none' },
    outline: {
      default: null,
      ':focus-visible': {
        default: null,
        '@media (forced-colors: active)': '2px solid transparent',
      },
    },
    outlineOffset: {
      default: null,
      ':focus-visible': { default: null, '@media (forced-colors: active)': '2px' },
    },
    '::after': {
      content: '""',
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: { default: '50%', ':is([data-panel-group-direction="vertical"])': 0 },
      width: { default: themeSpace[1], ':is([data-panel-group-direction="vertical"])': '100%' },
      height: { default: null, ':is([data-panel-group-direction="vertical"])': themeSpace[1] },
      translate: { default: '-50% 0', ':is([data-panel-group-direction="vertical"])': '0 -50%' },
    },
  },
  edge: {
    backgroundColor: 'transparent',
    '::after': {
      content: 'var(--tw-content)',
      insetBlock: 'calc(var(--spacing) * 0)',
      top: 'calc(var(--spacing) * 0)',
      bottom: 'calc(var(--spacing) * 0)',
      left: 'calc(var(--spacing) * 0)',
      width: '2px',
      '--tw-translate-x': 'calc(var(--spacing) * 0)',
      translate: 'var(--tw-translate-x) var(--tw-translate-y)',
      '--tw-duration': '.15s',
      transitionProperty:
        'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
      transitionDuration: '150ms',
      transitionTimingFunction: 'var(--tw-ease, var(--default-transition-timing-function))',
      transitionDelay: { default: null, ':is([data-resize-handle-state="hover"])': '150ms' },
      backgroundColor: {
        default: null,
        ':is([data-resize-handle-state="hover"])':
          'color-mix(in oklab, hsl(var(--sidebar-ring) / 1) 50%, transparent)',
        ':is([data-resize-handle-state="drag"])':
          'color-mix(in oklab, hsl(var(--sidebar-ring) / 1) 70%, transparent)',
      },
    },
  },
  grip: {
    backgroundColor: themeColors.border,
    zIndex: 10,
    display: 'flex',
    height: themeSpace[4],
    width: themeSpace[3],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.xs,
    borderWidth: '1px',
    borderStyle: 'solid',
    rotate: {
      default: null,
      [stylex.when.ancestor(
        ':is([data-slot="resizable-handle"][data-panel-group-direction="vertical"])'
      )]: '90deg',
    },
  },
  glyph: { height: themeSpace[2.5], width: themeSpace[2.5] },
});

function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>) {
  return (
    <ResizablePrimitive.PanelGroup
      data-slot="resizable-panel-group"
      {...withClassName(stylex.props(styles.group), className)}
      {...props}
    />
  );
}

const ResizablePanel = React.forwardRef<
  React.ElementRef<typeof ResizablePrimitive.Panel>,
  React.ComponentPropsWithoutRef<typeof ResizablePrimitive.Panel>
>(function ResizablePanel(props, ref) {
  return <ResizablePrimitive.Panel ref={ref} data-slot="resizable-panel" {...props} />;
});

function ResizableHandle({
  withHandle,
  appearance,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle> & {
  withHandle?: boolean;
  /** A two-pixel leading edge with the session panel's delayed hover and drag ink. */
  appearance?: 'edge';
}) {
  return (
    <ResizablePrimitive.PanelResizeHandle
      data-slot="resizable-handle"
      {...withClassName(
        stylex.props(stylex.defaultMarker(), styles.handle, appearance === 'edge' && styles.edge),
        className
      )}
      {...props}
    >
      {withHandle && (
        <div {...stylex.props(styles.grip)}>
          <GripVerticalIcon {...stylex.props(styles.glyph)} />
        </div>
      )}
    </ResizablePrimitive.PanelResizeHandle>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };

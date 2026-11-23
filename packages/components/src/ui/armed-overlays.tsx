import * as React from 'react';
import { ContextMenu as UiContextMenu } from '@lody/ui/context-menu';
import { Menu as UiMenu } from '@lody/ui/menu';
import { Popover as UiPopover } from '@lody/ui/popover';
import { Tooltip as UiTooltip } from '@lody/ui/tooltip';
import { InteractionArmedProvider, useInteractionArmed } from './interaction-arm';

/**
 * `@lody/ui`'s `Tooltip`, `Popover`, `Menu` and `ContextMenu` for surfaces inside an
 * `useInteractionArm` boundary (conversation rows). Armed, each part is the
 * package's own. Unarmed, a root renders only its children, a trigger renders
 * the element Base UI would have rendered (its `render` element or default tag,
 * with the caller's props) and content renders nothing, so a closed overlay
 * costs a row nothing until the pointer or focus reaches it.
 *
 * Outside a boundary the context is armed and these are the package's parts.
 */

/** Props a Base UI trigger consumes itself; a plain element must not receive them. */
const TRIGGER_ONLY_PROPS = [
  'closeDelay',
  'delay',
  'handle',
  'nativeButton',
  'openOnHover',
  'payload',
] as const;

/** The closed state a trigger's `className`/`style`/`render` callbacks read. */
const CLOSED_STATE = { open: false, disabled: false } as const;

type AnyProps = Record<string, unknown>;
type RenderProp =
  | React.ReactElement<AnyProps>
  | ((props: AnyProps, state: typeof CLOSED_STATE) => React.ReactElement)
  | undefined;

function composeHandlers(
  own: unknown,
  theirs: unknown
): ((...args: unknown[]) => void) | undefined {
  if (typeof own !== 'function')
    return typeof theirs === 'function' ? (theirs as never) : undefined;
  if (typeof theirs !== 'function') return own as never;
  return (...args: unknown[]) => {
    (own as (...a: unknown[]) => void)(...args);
    (theirs as (...a: unknown[]) => void)(...args);
  };
}

/**
 * Merges a trigger's props onto its `render` element the way Base UI does:
 * handlers run the trigger's first, class names join, styles spread, and the
 * trigger's own props win otherwise.
 */
function mergeTriggerProps(element: AnyProps, trigger: AnyProps): AnyProps {
  const merged: AnyProps = { ...element, ...trigger };
  for (const key of Object.keys(trigger)) {
    if (/^on[A-Z]/.test(key)) merged[key] = composeHandlers(trigger[key], element[key]);
  }
  if (element.className && trigger.className) {
    merged.className = `${String(element.className)} ${String(trigger.className)}`;
  }
  if (element.style && trigger.style) {
    merged.style = { ...(element.style as object), ...(trigger.style as object) };
  }
  if (trigger.children === undefined) merged.children = element.children;
  return merged;
}

/** The element a Base UI trigger renders, without Base UI. */
function renderPlainTrigger(
  props: AnyProps & { render?: RenderProp },
  ref: React.Ref<HTMLElement>,
  defaultTag: 'button' | 'div',
  extra?: AnyProps
): React.ReactElement {
  const { render, ...rest } = props;
  const own: AnyProps = { ...extra, ...rest, ref };
  for (const key of TRIGGER_ONLY_PROPS) delete own[key];
  if (typeof own.className === 'function') own.className = own.className(CLOSED_STATE);
  if (typeof own.style === 'function') own.style = own.style(CLOSED_STATE);
  if (typeof render === 'function') return render(own, CLOSED_STATE);
  if (React.isValidElement<AnyProps>(render)) {
    return React.cloneElement(render, mergeTriggerProps(render.props, own));
  }
  const Tag = defaultTag;
  return defaultTag === 'button' ? <Tag type="button" {...own} /> : <Tag {...own} />;
}

/** A root opened by its owner rather than an interaction mounts for real. */
function isOwnerOpened(props: AnyProps): boolean {
  return props.open === true || props.defaultOpen === true;
}

// Each wrapper keeps the exact type of the part it wraps.
// oxlint-disable-next-line typescript/no-explicit-any
type AnyComponent = React.ComponentType<any>;

function armedRoot<C extends AnyComponent>(Ui: C, name: string): C {
  const UiRoot = Ui as React.ComponentType<AnyProps>;
  function ArmedRoot(props: AnyProps & { children?: React.ReactNode }) {
    const armed = useInteractionArmed();
    if (armed) return <UiRoot {...props} />;
    if (isOwnerOpened(props)) {
      return (
        <InteractionArmedProvider value>
          <UiRoot {...props} />
        </InteractionArmedProvider>
      );
    }
    return <>{props.children}</>;
  }
  ArmedRoot.displayName = `Armed${name}`;
  return ArmedRoot as unknown as C;
}

function armedContent<C extends AnyComponent>(Ui: C, name: string): C {
  const UiContent = Ui as React.ComponentType<AnyProps>;
  const ArmedContent = React.forwardRef<HTMLElement, AnyProps>((props, ref) => {
    const armed = useInteractionArmed();
    if (!armed) return null;
    return <UiContent {...props} ref={ref} />;
  });
  ArmedContent.displayName = `Armed${name}`;
  return ArmedContent as unknown as C;
}

function armedTrigger<C extends AnyComponent>(
  Ui: C,
  name: string,
  defaultTag: 'button' | 'div',
  extra?: AnyProps
): C {
  const UiTrigger = Ui as React.ComponentType<AnyProps>;
  const ArmedTrigger = React.forwardRef<HTMLElement, AnyProps>((props, ref) => {
    const armed = useInteractionArmed();
    if (armed) return <UiTrigger {...props} ref={ref} />;
    return renderPlainTrigger(props, ref, defaultTag, extra);
  });
  ArmedTrigger.displayName = `Armed${name}`;
  return ArmedTrigger as unknown as C;
}

function ArmedTooltipProvider(props: React.ComponentProps<typeof UiTooltip.Provider>) {
  const armed = useInteractionArmed();
  if (!armed) return <>{props.children}</>;
  return <UiTooltip.Provider {...props} />;
}

export const Tooltip = {
  ...UiTooltip,
  Provider: ArmedTooltipProvider,
  Root: armedRoot(UiTooltip.Root, 'TooltipRoot'),
  Trigger: armedTrigger(UiTooltip.Trigger, 'TooltipTrigger', 'button'),
  Content: armedContent(UiTooltip.Content, 'TooltipContent'),
};

export const Popover = {
  ...UiPopover,
  Root: armedRoot(UiPopover.Root, 'PopoverRoot'),
  Trigger: armedTrigger(UiPopover.Trigger, 'PopoverTrigger', 'button'),
  Content: armedContent(UiPopover.Content, 'PopoverContent'),
};

export const ContextMenu = {
  ...UiContextMenu,
  Root: armedRoot(UiContextMenu.Root, 'ContextMenuRoot'),
  // `@lody/ui`'s trigger lays out nothing of its own (`display: contents`).
  Trigger: armedTrigger(UiContextMenu.Trigger, 'ContextMenuTrigger', 'div', {
    style: { display: 'contents' },
  }),
  Content: armedContent(UiContextMenu.Content, 'ContextMenuContent'),
};

export const Menu = {
  ...UiMenu,
  Root: armedRoot(UiMenu.Root, 'MenuRoot'),
  Trigger: armedTrigger(UiMenu.Trigger, 'MenuTrigger', 'button'),
  Content: armedContent(UiMenu.Content, 'MenuContent'),
};

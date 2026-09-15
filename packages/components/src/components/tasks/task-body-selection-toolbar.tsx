import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bold,
  Code,
  Highlighter,
  Italic,
  Link as LinkIcon,
  Quote,
  RemoveFormatting,
  SquareCheck,
  Strikethrough,
  Unlink,
  type LucideIcon,
} from 'lucide-react';
import { useEditor } from '@prosekit/react';
import {
  InlinePopoverPopup,
  InlinePopoverPositioner,
  InlinePopoverRoot,
} from '@prosekit/react/inline-popover';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Toggle } from '@lody/ui/toggle';
import { Toolbar } from '@lody/ui/toolbar';

/**
 * Floating format toolbar over a text selection.
 *
 * Why this exists alongside meowdown's own selection menu: that menu's item type
 * is `{ id, label, detail?, onSelect }` — a searchable command LIST, with no
 * icons, no grouping, and no render slot. A one-row `B I S 🔗` toolbar cannot be
 * expressed in it at all. What meowdown does give us is `children` rendered
 * inside its ProseKit context, and ProseKit ships `InlinePopover`, which anchors
 * to the live text selection.
 *
 * This is now the ONLY formatting surface. meowdown's searchable selection menu
 * (and the small floating affordance that opened it) is switched off: two
 * overlays competing for the same selection anchor meant the searchable one
 * never became visible when opened from here, and a formatting UI split across
 * two popovers was the thing this was meant to fix.
 *
 * Behaviors that make a bubble menu feel right, all deliberate:
 *
 * - **Never steal focus.** Every control cancels its own `pointerdown`. One
 *   blur and the selection collapses, so the command would have nothing to act
 *   on — this is the single most common way these menus break.
 * - **Anchored to the selection, hoisted above clipping ancestors.** The task
 *   body sits inside a `ScrollArea`; without hoisting the popover is clipped by
 *   its `overflow`.
 * - **Escape closes**, which `InlinePopoverRoot` handles.
 */

type ToolbarCommands = {
  toggleStrong?: () => void;
  toggleEm?: () => void;
  toggleCode?: () => void;
  toggleDel?: () => void;
  toggleHighlight?: () => void;
  wrapInSquareTask?: () => void;
  insertLink?: (options?: { href?: string }) => void;
  removeLink?: () => void;
  setParagraph?: () => void;
};

export type TaskBodySelectionToolbarProps = {
  /** Quote the selection into the task's comment box. */
  onQuote?: () => void;
};

/**
 * A mark that stays on while the selection carries it.
 *
 * `Toolbar.Button` is what puts a control into the bar's roving focus, and
 * `render` is how a control is composed into a Base UI part here — so the whole
 * bar is one tab stop and the arrow keys walk it, rather than eight stops on
 * the way past a text selection.
 */
function FormatToggle({
  icon: Icon,
  label,
  active = false,
  onTrigger,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onTrigger: () => void;
}) {
  return (
    <Toolbar.Button
      render={
        <Toggle
          size="small"
          icon
          pressed={active}
          onPressedChange={onTrigger}
          // The whole reason the toolbar can act on a selection: pointerdown
          // would otherwise move focus out of the editor and collapse it
          // before click.
          onPointerDown={(event) => event.preventDefault()}
          aria-label={label}
          title={label}
        />
      }
    >
      <Icon className="size-full" aria-hidden="true" />
    </Toolbar.Button>
  );
}

/**
 * A command in the same bar: it acts and leaves nothing pressed behind, so it
 * is a ghost Button rather than a Toggle.
 */
function FormatAction({
  icon: Icon,
  label,
  onTrigger,
}: {
  icon: LucideIcon;
  label: string;
  onTrigger: () => void;
}) {
  return (
    <Toolbar.Button
      render={
        <Button
          variant="ghost"
          size="small"
          icon
          onClick={onTrigger}
          onPointerDown={(event) => event.preventDefault()}
          aria-label={label}
          title={label}
        />
      }
    >
      <Icon className="size-full" aria-hidden="true" />
    </Toolbar.Button>
  );
}

export function TaskBodySelectionToolbar({ onQuote }: TaskBodySelectionToolbarProps) {
  const { t } = useTranslation();
  const editor = useEditor({ update: true });
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState('');
  const linkInputRef = useRef<HTMLInputElement | null>(null);

  const commands = editor?.commands as ToolbarCommands | undefined;

  // `isActive` is not on every meowdown build's public surface, so probe it
  // rather than assume: an absent probe means "unknown", which renders as
  // not-pressed instead of throwing.
  const isMarkActive = useCallback(
    (name: string): boolean => {
      const probe = (editor as unknown as { marks?: Record<string, { isActive?: () => boolean }> })
        ?.marks?.[name];
      try {
        return probe?.isActive?.() ?? false;
      } catch {
        return false;
      }
    },
    [editor]
  );

  useEffect((): (() => void) | undefined => {
    if (!linkOpen) return undefined;
    // rAF: the popup is positioned after paint, and focusing earlier scrolls
    // the anchor out from under it.
    const id = requestAnimationFrame(() => linkInputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [linkOpen]);

  const closeLink = useCallback(() => {
    setLinkOpen(false);
    setHref('');
  }, []);

  const submitLink = useCallback(() => {
    const trimmed = href.trim();
    if (trimmed) {
      commands?.insertLink?.({ href: trimmed });
    }
    closeLink();
  }, [closeLink, commands, href]);

  return (
    <InlinePopoverRoot
      // `detail` is the open flag (aria-ui's OpenChangeEvent), not a boolean arg.
      // Reset the link sub-state on close so reopening starts on the button row.
      onOpenChange={(event) => {
        if (!event.detail) closeLink();
      }}
    >
      <InlinePopoverPositioner
        placement="top"
        offset={8}
        // The editor lives inside a ScrollArea; without hoisting to the top
        // layer the popover is clipped by its overflow.
        hoist
      >
        <InlinePopoverPopup>
          <Toolbar.Root
            aria-label={t('tasks.body.formatToolbar', 'Format selection')}
            // The bar itself draws nothing, so the surface under it is this
            // popover's and stays here until the popover is a primitive too.
            className="rounded-lg border border-border bg-popover p-1 shadow-md"
            onPointerDown={(event) => event.preventDefault()}
          >
            {linkOpen ? (
              // Link is a sub-state of the same popover, not a second surface:
              // it replaces the row in place so the bar does not jump.
              <Toolbar.Group className="px-1">
                <LinkIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <Input
                  ref={linkInputRef}
                  size="small"
                  className="w-56"
                  value={href}
                  onChange={(event) => setHref(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      submitLink();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      closeLink();
                    }
                  }}
                  placeholder={t('tasks.body.linkPlaceholder', 'Paste or type a link')}
                />
                <FormatAction
                  icon={Unlink}
                  label={t('tasks.body.format.removeLink', 'Remove link')}
                  onTrigger={() => {
                    commands?.removeLink?.();
                    closeLink();
                  }}
                />
              </Toolbar.Group>
            ) : (
              <>
                <Toolbar.Group aria-label={t('tasks.body.format.marks', 'Marks')}>
                  <FormatToggle
                    icon={Bold}
                    label={t('tasks.body.format.bold', 'Bold')}
                    active={isMarkActive('strong')}
                    onTrigger={() => commands?.toggleStrong?.()}
                  />
                  <FormatToggle
                    icon={Italic}
                    label={t('tasks.body.format.italic', 'Italic')}
                    active={isMarkActive('em')}
                    onTrigger={() => commands?.toggleEm?.()}
                  />
                  <FormatToggle
                    icon={Strikethrough}
                    label={t('tasks.body.format.strike', 'Strikethrough')}
                    active={isMarkActive('del')}
                    onTrigger={() => commands?.toggleDel?.()}
                  />
                  <FormatToggle
                    icon={Code}
                    label={t('tasks.body.format.code', 'Code')}
                    active={isMarkActive('code')}
                    onTrigger={() => commands?.toggleCode?.()}
                  />
                  <FormatToggle
                    icon={Highlighter}
                    label={t('tasks.body.format.highlight', 'Highlight')}
                    active={isMarkActive('highlight')}
                    onTrigger={() => commands?.toggleHighlight?.()}
                  />
                </Toolbar.Group>

                <Toolbar.Separator />

                <Toolbar.Group aria-label={t('tasks.body.format.blocks', 'Blocks')}>
                  <FormatAction
                    icon={LinkIcon}
                    label={t('tasks.body.format.link', 'Link')}
                    onTrigger={() => setLinkOpen(true)}
                  />
                  <FormatAction
                    icon={SquareCheck}
                    label={t('tasks.body.format.task', 'Turn into task item')}
                    onTrigger={() => commands?.wrapInSquareTask?.()}
                  />
                  <FormatAction
                    icon={RemoveFormatting}
                    label={t('tasks.body.format.clear', 'Clear formatting')}
                    onTrigger={() => commands?.setParagraph?.()}
                  />
                </Toolbar.Group>

                {onQuote ? (
                  <>
                    <Toolbar.Separator />
                    <FormatAction
                      icon={Quote}
                      label={t('tasks.body.quote', 'Quote selection')}
                      onTrigger={onQuote}
                    />
                  </>
                ) : null}
              </>
            )}
          </Toolbar.Root>
        </InlinePopoverPopup>
      </InlinePopoverPositioner>
    </InlinePopoverRoot>
  );
}

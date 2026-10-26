import { useWorkspaceFeature } from '@/hooks/use-workspace-feature';
import { useState } from 'react';
import { ChevronLeft, ChevronRight, Paperclip, Plug, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { describeMcpConnection, type McpServerId, type WorkspaceMcpServerMeta } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { cn } from '@/lib/utils';
import { Menu } from '@/ui/menu';
import { MCP_TRANSPORT_LABELS } from '@/components/shared/mcp-transport';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontSize, themeSpace } from '../../style/theme-scale.stylex';

/** Per-turn MCP selection, surfaced as a second level of the "+" menu. */
export interface AttachmentAddMenuMcp {
  servers: readonly WorkspaceMcpServerMeta[];
  selectedIds: readonly McpServerId[];
  onSelectedIdsChange: (ids: McpServerId[]) => void;
  /** Existing conversation: the change applies the next time the agent starts. */
  existingSession?: boolean;
  disabled?: boolean;
}

export interface AttachmentAddMenuProps {
  /** Larger trigger + roomier items for touch; desktop and mobile both use the
   *  same upward popover dropdown. */
  isMobile: boolean;
  /** Smaller trigger for the landing composer variant. */
  isLanding?: boolean;
  /** Disables the whole trigger (e.g. the prompt is disabled). */
  disabled?: boolean;
  /** Omit the callback to hide the attachment item entirely. The picker is
   * intentionally unfiltered; its owner routes the selected files by MIME. */
  onAddAttachment?: () => void;
  attachmentDisabled?: boolean;
  /** Omit (or pass an empty catalog) to hide the MCP entry entirely. */
  mcp?: AttachmentAddMenuMcp;
}

/**
 * The pushed panel slides in from the right and the root returns from the
 * left. These are the `tw-animate-css` `enter` keyframes, restated: the panel
 * fades in while it slides half a spacing step.
 */
const enterFromRight = stylex.keyframes({
  from: { opacity: 0, transform: 'translate3d(0.5rem, 0, 0)' },
  to: { opacity: 1, transform: 'none' },
});
const enterFromLeft = stylex.keyframes({
  from: { opacity: 0, transform: 'translate3d(-0.5rem, 0, 0)' },
  to: { opacity: 1, transform: 'none' },
});

const styles = stylex.create({
  /** The pushed MCP panel enters from the right; the root returns from the left. */
  panelFromRight: {
    animationName: enterFromRight,
    animationDuration: '150ms',
    animationTimingFunction: 'ease',
    animationDelay: '0s',
    animationIterationCount: 1,
    animationDirection: 'normal',
    animationFillMode: 'none',
  },
  panelFromLeft: {
    animationName: enterFromLeft,
    animationDuration: '150ms',
    animationTimingFunction: 'ease',
    animationDelay: '0s',
    animationIterationCount: 1,
    animationDirection: 'normal',
    animationFillMode: 'none',
  },
  plusLarge: { width: themeSpace[6], height: themeSpace[6] },
  plusSmall: { width: themeSpace[4], height: themeSpace[4] },
  chevron: {
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
    color: themeColors.mutedForeground,
  },
  /** The multi-select row's own column: the name over its detail. */
  rowBody: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    flexDirection: 'column',
  },
  rowName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rowNameMobile: { fontSize: '15px' },
  rowDetail: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: themeFontSize.xs,
    lineHeight: '1.375',
    color: themeColors.mutedForeground,
  },
  hint: {
    userSelect: 'none',
    paddingInline: themeSpace[2.5],
    paddingBottom: themeSpace[1.5],
    paddingTop: themeSpace[2],
    fontSize: '11px',
    lineHeight: '1.375',
    color: themeColors.mutedForeground,
  },
});

/**
 * The single bottom-left "+" entry point for the composer. One rounded "+" that
 * opens an upward popover dropdown with one attachment picker plus the per-turn
 * MCP selection. Same dropdown on desktop and mobile (mobile just gets larger
 * touch targets).
 *
 * MCP is a second level, not a flat list, because a workspace can register many
 * servers and they are multi-select. Desktop opens it as a hover submenu;
 * touch has no hover, so mobile PUSHES the panel onto the same surface (a
 * back row returns) rather than flying a submenu out past the screen edge.
 *
 * Otherwise pure/presentational: the unfiltered file picker lives in
 * onAddAttachment. Drag/drop and paste bypass this menu entirely.
 */
export function AttachmentAddMenu({
  isMobile,
  isLanding,
  disabled,
  onAddAttachment: requestedAddAttachment,
  attachmentDisabled,
  mcp,
}: AttachmentAddMenuProps) {
  const attachmentAllowed = useWorkspaceFeature('attachments');
  const onAddAttachment = attachmentAllowed ? requestedAddAttachment : undefined;
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Mobile's pushed panel. Desktop uses a real submenu and stays on 'root'.
  const [view, setView] = useState<'root' | 'mcp'>('root');
  const triggerLabel = t('sessions.addAttachmentMenu', 'Add attachment');

  const mcpServers = mcp?.servers ?? [];
  const hasMcp = mcpServers.length > 0;
  if (!onAddAttachment && !hasMcp) {
    return null;
  }

  // The trigger, the menu items and the menu surface are `@lody/ui`
  // primitives, so their own classes stay Tailwind: a StyleX class would
  // compete with the primitive's own styles inside the `stylex` layer.
  const triggerSize = !isLanding && isMobile ? 'size-9' : 'size-7';
  const itemClass = cn('cursor-pointer', isMobile && 'gap-2.5 py-2.5 text-[15px]');
  const plusClassName = stylex.props(isMobile ? styles.plusLarge : styles.plusSmall).className;
  const selectedCount = mcp
    ? mcp.selectedIds.filter((id) => mcpServers.some((server) => server.id === id)).length
    : 0;
  const mcpLabel =
    selectedCount > 0
      ? t('session.mcp.loadCount', { count: selectedCount })
      : t('session.mcp.loadNone');

  return (
    <Menu.Root
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        // Always reopen at the root level; a stale pushed panel would hide the
        // upload actions behind a back row.
        if (!nextOpen) setView('root');
      }}
    >
      <Menu.Trigger
        render={
          <Button
            type="button"
            variant="ghost"
            icon
            disabled={disabled}
            aria-label={triggerLabel}
            className={cn(
              triggerSize,
              // Light-stroke "+" with a circular hover/open fill. `bg-hover` (not
              // `bg-accent`/`bg-muted`) because those equal the background in the
              // dark theme and paint nothing.
              'data-[state=open]:bg-hover data-[state=open]:text-foreground'
            )}
          >
            <Plus strokeWidth={1.5} className={plusClassName} />
          </Button>
        }
      >
        <Button
          type="button"
          variant="ghost"
          icon
          disabled={disabled}
          aria-label={triggerLabel}
          className={cn(
            triggerSize,
            // Light-stroke "+" with a circular hover/open fill. `bg-hover` (not
            // `bg-accent`/`bg-muted`) because those equal the background in the
            // dark theme and paint nothing.
            'data-[state=open]:bg-hover data-[state=open]:text-foreground'
          )}
        >
          <Plus strokeWidth={1.5} className={plusClassName} />
        </Button>
      </Menu.Trigger>
      <Menu.Content
        align="start"
        side="top"
        /* Size to the widest item (`w-max`) so short attachment labels don't
           leave a wide blank gutter; a small floor keeps it from
           collapsing too narrow. The pushed MCP panel needs room for server
           names, so it takes its own floor and ceiling. */
        className={cn(
          view === 'mcp'
            ? 'w-[min(20rem,calc(100vw-2rem))]'
            : cn('w-max', isMobile ? 'min-w-[160px]' : 'min-w-[140px]')
        )}
      >
        {view === 'mcp' && mcp ? (
          // Keyed so the panel swap replays the slide: the pushed level enters
          // from the right, the root returns from the left.
          <div key="mcp" {...stylex.props(styles.panelFromRight)}>
            <Menu.Item
              className={cn(itemClass, 'font-medium')}
              closeOnClick={false}
              onClick={() => setView('root')}
              icon={ChevronLeft}
            >
              {t('session.mcp.title')}
            </Menu.Item>
            <Menu.Separator />
            <McpServerItems mcp={mcp} isMobile={isMobile} />
          </div>
        ) : (
          <div key="root" {...stylex.props(styles.panelFromLeft)}>
            {onAddAttachment ? (
              <Menu.Item
                onClick={onAddAttachment}
                disabled={attachmentDisabled}
                className={itemClass}
                icon={Paperclip}
              >
                {triggerLabel}
              </Menu.Item>
            ) : null}
            {hasMcp && mcp ? (
              <>
                {onAddAttachment ? <Menu.Separator /> : null}
                {isMobile ? (
                  <Menu.Item
                    className={itemClass}
                    disabled={mcp.disabled}
                    closeOnClick={false}
                    onClick={() => setView('mcp')}
                    icon={Plug}
                    endContent={
                      <ChevronRight {...stylex.props(styles.chevron)} aria-hidden="true" />
                    }
                  >
                    {mcpLabel}
                  </Menu.Item>
                ) : (
                  <Menu.Submenu>
                    <Menu.SubmenuTrigger className={itemClass} disabled={mcp.disabled} icon={Plug}>
                      {mcpLabel}
                    </Menu.SubmenuTrigger>
                    <Menu.Content className="w-[min(20rem,calc(100vw-2rem))]">
                      <McpServerItems mcp={mcp} isMobile={isMobile} />
                    </Menu.Content>
                  </Menu.Submenu>
                )}
              </>
            ) : null}
          </div>
        )}
      </Menu.Content>
    </Menu.Root>
  );
}

/** The multi-select rows themselves, shared by the desktop submenu and the
 *  mobile pushed panel. Toggling keeps the menu open — that is the feedback. */
function McpServerItems({ mcp, isMobile }: { mcp: AttachmentAddMenuMcp; isMobile: boolean }) {
  const { t } = useTranslation();
  const selected = new Set(mcp.selectedIds);
  const toggle = (id: McpServerId, checked: boolean) => {
    mcp.onSelectedIdsChange(
      checked
        ? [...mcp.selectedIds.filter((selectedId) => selectedId !== id), id]
        : mcp.selectedIds.filter((selectedId) => selectedId !== id)
    );
  };

  return (
    <>
      {mcp.servers.map((server) => {
        const detail =
          server.description ??
          describeMcpConnection(server.connection) ??
          MCP_TRANSPORT_LABELS[server.transport];
        return (
          <Menu.CheckboxItem
            key={server.id}
            checked={selected.has(server.id)}
            disabled={mcp.disabled}
            // Stays `items-center` (the shared selection-item default): the check
            // indicator is absolutely positioned from its static spot, so the row's
            // own alignment is what centers it against the two-line label.
            className={cn(isMobile && 'py-2.5')}
            closeOnClick={false}
            onCheckedChange={(checked) => toggle(server.id, checked === true)}
          >
            <span {...stylex.props(styles.rowBody)}>
              <span {...stylex.props(styles.rowName, isMobile && styles.rowNameMobile)}>
                {server.name}
              </span>
              <span
                className={[
                  stylex.props(styles.rowDetail).className,
                  // `font-mono` is the app's own global class; it keeps the
                  // server's own detail in the mono face.
                  server.description ? undefined : 'font-mono',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {detail}
              </span>
            </span>
          </Menu.CheckboxItem>
        );
      })}
      {mcp.existingSession ? (
        <p {...stylex.props(styles.hint)}>{t('session.mcp.nextStartHint')}</p>
      ) : null}
    </>
  );
}

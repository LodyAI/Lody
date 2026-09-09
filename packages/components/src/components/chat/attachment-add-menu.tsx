import { useState } from 'react';
import { ChevronLeft, ChevronRight, Paperclip, Plug, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { describeMcpConnection, type McpServerId, type WorkspaceMcpServerMeta } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { MCP_TRANSPORT_LABELS } from '@/components/shared/mcp-transport';

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
   * same upward popover dropdown. */
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
  onAddAttachment,
  attachmentDisabled,
  mcp,
}: AttachmentAddMenuProps) {
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

  const triggerSize = !isLanding && isMobile ? 'size-9' : 'size-7';
  const itemClass = cn('cursor-pointer', isMobile && 'gap-2.5 py-2.5 text-[15px]');
  const iconClass = 'size-4 shrink-0 text-muted-foreground';
  const selectedCount = mcp
    ? mcp.selectedIds.filter((id) => mcpServers.some((server) => server.id === id)).length
    : 0;
  const mcpLabel =
    selectedCount > 0
      ? t('session.mcp.loadCount', { count: selectedCount })
      : t('session.mcp.loadNone');

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        // Always reopen at the root level; a stale pushed panel would hide the
        // upload actions behind a back row.
        if (!nextOpen) setView('root');
      }}
    >
      <DropdownMenuTrigger asChild>
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
          <Plus strokeWidth={1.5} className={isMobile ? 'size-6' : 'size-5'} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
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
          <div key="mcp" className="animate-in fade-in-0 slide-in-from-right-2 duration-150">
            <DropdownMenuItem
              className={cn(itemClass, 'gap-2 font-medium')}
              onSelect={(event) => {
                event.preventDefault();
                setView('root');
              }}
            >
              <ChevronLeft className={iconClass} />
              {t('session.mcp.title')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <McpServerItems mcp={mcp} isMobile={isMobile} />
          </div>
        ) : (
          <div key="root" className="animate-in fade-in-0 slide-in-from-left-2 duration-150">
            {onAddAttachment ? (
              <DropdownMenuItem
                onSelect={onAddAttachment}
                disabled={attachmentDisabled}
                className={itemClass}
              >
                <Paperclip className={iconClass} />
                {triggerLabel}
              </DropdownMenuItem>
            ) : null}
            {hasMcp && mcp ? (
              <>
                {onAddAttachment ? <DropdownMenuSeparator /> : null}
                {isMobile ? (
                  <DropdownMenuItem
                    className={itemClass}
                    disabled={mcp.disabled}
                    onSelect={(event) => {
                      event.preventDefault();
                      setView('mcp');
                    }}
                  >
                    <Plug className={iconClass} />
                    <span className="min-w-0 flex-1 truncate">{mcpLabel}</span>
                    <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" />
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger className={itemClass} disabled={mcp.disabled}>
                      <Plug className={iconClass} />
                      <span className="min-w-0 flex-1 truncate">{mcpLabel}</span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-[min(20rem,calc(100vw-2rem))]">
                      <McpServerItems mcp={mcp} isMobile={isMobile} />
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
              </>
            ) : null}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
          <DropdownMenuCheckboxItem
            key={server.id}
            checked={selected.has(server.id)}
            disabled={mcp.disabled}
            // Stays `items-center` (the shared selection-item default): the check
            // indicator is absolutely positioned from its static spot, so the row's
            // own alignment is what centers it against the two-line label.
            className={cn(isMobile && 'py-2.5')}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => toggle(server.id, checked === true)}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={cn('truncate', isMobile && 'text-[15px]')}>{server.name}</span>
              <span
                className={cn(
                  'truncate text-xs leading-snug text-muted-foreground',
                  server.description ? undefined : 'font-mono'
                )}
              >
                {detail}
              </span>
            </span>
          </DropdownMenuCheckboxItem>
        );
      })}
      {mcp.existingSession ? (
        <p className="select-none px-2.5 pb-1.5 pt-2 text-[11px] leading-snug text-muted-foreground">
          {t('session.mcp.nextStartHint')}
        </p>
      ) : null}
    </>
  );
}

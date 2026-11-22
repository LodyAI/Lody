import { WorkspaceFeatureReasonText } from '@/components/workspace-feature-notice';
import { useWorkspaceFeatureReason } from '@/hooks/use-workspace-feature';
import { useRef, useState } from 'react';
import { Clock, ChevronLeft, ChevronRight, Paperclip, Plug, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { describeMcpConnection, type McpServerId, type WorkspaceMcpServerMeta } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Kbd } from '@lody/ui/kbd';
import { Tooltip } from '@lody/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  commands,
  composerScopedKeybindings,
  formatKeyBinding,
  getCommandKeybindings,
  useCommand,
  useCommands,
} from '@/lib/commands';
import { Menu } from '@/ui/menu';
import { MCP_TRANSPORT_LABELS } from '@/components/shared/mcp-transport';

/**
 * Desktop flyout and the mobile pushed panel. A real length, not
 * `w-[min(20rem,calc(100vw-2rem))]`: that calc is invalid CSS (the minus needs
 * spaces), so the declaration was dropped and the panel grew out to
 * `--available-width` — a one-line description then stretched across the
 * composer and the footnote landed on the model row.
 */
const MCP_PANEL_CLASS = 'w-80 max-w-[calc(100vw_-_2rem)]';

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
  isSheet?: boolean;
  /** Disables the whole trigger (e.g. the prompt is disabled). */
  disabled?: boolean;
  /** Omit the callback to hide the attachment item entirely. The picker is
   * intentionally unfiltered; its owner routes the selected files by MIME. */
  onAddAttachment?: () => void;
  attachmentDisabled?: boolean;
  onScheduleSend?: () => void;
  scheduleDisabledReason?: string;
  /** Omit (or pass an empty catalog) to hide the MCP entry entirely. */
  mcp?: AttachmentAddMenuMcp;
  /** Register the `session.openAddMenu` command only while this surface owns
   *  the composer's shortcuts (hidden retained panes pass `false`). */
  commandsEnabled?: boolean;
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
  isSheet,
  disabled,
  onAddAttachment,
  attachmentDisabled,
  onScheduleSend,
  scheduleDisabledReason,
  mcp,
  commandsEnabled = true,
}: AttachmentAddMenuProps) {
  const scheduleFeatureReason = useWorkspaceFeatureReason('schedules');
  const attachmentFeatureReason = useWorkspaceFeatureReason('attachments');
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Mobile's pushed panel. Desktop uses a real submenu and stays on 'root'.
  const [view, setView] = useState<'root' | 'mcp'>('root');
  // iOS dismisses the file picker as soon as the prompt regains focus (the
  // keyboard returns instead), so choosing the picker skips the composer
  // focus restore every other selection gets.
  const filePickerOpenedRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const triggerLabel = t('sessions.addAttachmentMenu', 'Add attachment');

  const mcpServers = mcp?.servers ?? [];
  const hasMcp = mcpServers.length > 0;
  const hasMenuContent = Boolean(onAddAttachment || hasMcp || onScheduleSend);

  useCommands(); // Rebinds re-render via the registry subscription so the hint follows.
  const openAddMenuKey = commands.getKeybindingsFor('session.openAddMenu')[0];

  useCommand(
    {
      id: 'session.openAddMenu',
      titleKey: 'commands.session.openAddMenu',
      title: t('commands.session.openAddMenu', 'Open Composer + Menu'),
      category: 'Session',
      keybindings: composerScopedKeybindings(
        getCommandKeybindings('session.openAddMenu'),
        () => triggerRef.current
      ),
      when: () => hasMenuContent && !disabled,
      run: () => setOpen(true),
    },
    commandsEnabled
  );

  if (!hasMenuContent) {
    return null;
  }

  const triggerSize = !isLanding && isMobile ? 'size-9' : 'size-7';
  const itemClass = cn('cursor-pointer', isMobile && 'gap-2.5 py-2.5 text-[15px]');
  const selectedCount = mcp
    ? mcp.selectedIds.filter((id) => mcpServers.some((server) => server.id === id)).length
    : 0;
  const mcpLabel =
    selectedCount > 0
      ? t('session.mcp.loadCount', { count: selectedCount })
      : t('session.mcp.loadNone');

  const scheduleDisabled = Boolean(scheduleFeatureReason || scheduleDisabledReason);
  const scheduleItem = onScheduleSend ? (
    <Menu.Item
      icon={Clock}
      onClick={onScheduleSend}
      disabled={scheduleDisabled}
      className={itemClass}
    >
      {scheduleFeatureReason ? (
        <WorkspaceFeatureReasonText reason={scheduleFeatureReason} />
      ) : (
        t('scheduledMessage.menu')
      )}
    </Menu.Item>
  ) : null;

  // A disabled menu row does not receive pointer events, so a `title` on it can
  // never show. Keep the row disabled and put the hover target on a wrapper that
  // owns the same box; the tooltip then explains the state without making the
  // command clickable.
  const scheduleEntry =
    scheduleItem && scheduleDisabled && !scheduleFeatureReason ? (
      <Tooltip.Root>
        <Tooltip.Trigger delay={0} render={<div />}>
          {scheduleItem}
        </Tooltip.Trigger>
        <Tooltip.Content side="right">{scheduleDisabledReason}</Tooltip.Content>
      </Tooltip.Root>
    ) : (
      scheduleItem
    );

  return (
    <Menu.Root
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) filePickerOpenedRef.current = false;
        // Always reopen at the root level; a stale pushed panel would hide the
        // upload actions behind a back row.
        if (!nextOpen) setView('root');
      }}
    >
      <Tooltip.Root>
        <Tooltip.Trigger
          delay={500}
          render={
            <Menu.Trigger
              ref={triggerRef}
              render={
                <Button
                  type="button"
                  variant="ghost"
                  icon
                  disabled={disabled}
                  aria-label={triggerLabel}
                  className={cn(
                    triggerSize,
                    isSheet && 'rounded-full bg-muted/55 text-foreground/80 dark:bg-input/80',
                    // Light-stroke "+" with a circular hover/open fill. `bg-hover` (not
                    // `bg-accent`/`bg-muted`) because those equal the background in the
                    // dark theme and paint nothing.
                    'data-[state=open]:bg-hover data-[state=open]:text-foreground'
                  )}
                >
                  <Plus strokeWidth={1.5} className={isMobile ? 'size-6' : 'size-4'} />
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
                  isSheet && 'rounded-full bg-muted/55 text-foreground/80 dark:bg-input/80',
                  // Light-stroke "+" with a circular hover/open fill. `bg-hover` (not
                  // `bg-accent`/`bg-muted`) because those equal the background in the
                  // dark theme and paint nothing.
                  'data-[state=open]:bg-hover data-[state=open]:text-foreground'
                )}
              >
                <Plus strokeWidth={1.5} className={isMobile ? 'size-6' : 'size-4'} />
              </Button>
            </Menu.Trigger>
          }
        />
        <Tooltip.Content side="top">
          {triggerLabel}
          {openAddMenuKey ? <> <Kbd>{formatKeyBinding(openAddMenuKey)}</Kbd></> : null}
        </Tooltip.Content>
      </Tooltip.Root>
      <Menu.Content
        align="start"
        side="top"
        finalFocus={() => !filePickerOpenedRef.current}
        /* Size to the widest item (`w-max`) so short attachment labels don't
           leave a wide blank gutter; a small floor keeps it from
           collapsing too narrow. The pushed MCP panel keeps a fixed width so
           a long server description wraps instead of stretching the composer. */
        className={cn(
          view === 'mcp'
            ? MCP_PANEL_CLASS
            : cn('w-max', isMobile ? 'min-w-[160px]' : 'min-w-[140px]')
        )}
      >
        {view === 'mcp' && mcp ? (
          // Keyed so the panel swap replays the slide: the pushed level enters
          // from the right, the root returns from the left.
          <div key="mcp" className="animate-in fade-in-0 slide-in-from-right-2 duration-150">
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
          <div key="root" className="animate-in fade-in-0 slide-in-from-left-2 duration-150">
            {onAddAttachment ? (
              <Menu.Item
                onClick={() => {
                  filePickerOpenedRef.current = true;
                  onAddAttachment();
                }}
                disabled={attachmentDisabled || !!attachmentFeatureReason}
                title={attachmentFeatureReason}
                className={itemClass}
                icon={Paperclip}
              >
                {attachmentFeatureReason ? (
                  <WorkspaceFeatureReasonText reason={attachmentFeatureReason} />
                ) : (
                  triggerLabel
                )}
              </Menu.Item>
            ) : null}
            {scheduleEntry}
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
                    endContent={<ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
                  >
                    {mcpLabel}
                  </Menu.Item>
                ) : (
                  <Menu.Submenu>
                    <Menu.SubmenuTrigger className={itemClass} disabled={mcp.disabled} icon={Plug}>
                      {mcpLabel}
                    </Menu.SubmenuTrigger>
                    {/* `end` keeps the panel above the composer toolbar. The
                        trigger is the last row of a menu that opens upward;
                        `start` (the submenu default) hangs the description and
                        the footnote down onto the model row. */}
                    <Menu.Content align="end" sideOffset={8} className={MCP_PANEL_CLASS}>
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
            <span className="flex min-w-0 flex-1 flex-col whitespace-normal">
              <span className={cn('truncate', isMobile && 'text-[15px]')}>{server.name}</span>
              <span
                className={cn(
                  // The row label slot is nowrap. Override it so a sentence wraps
                  // inside the panel instead of stretching the panel to the sentence.
                  'line-clamp-2 whitespace-normal break-words text-xs leading-snug',
                  'text-muted-foreground',
                  server.description ? undefined : 'font-mono'
                )}
              >
                {detail}
              </span>
            </span>
          </Menu.CheckboxItem>
        );
      })}
      {mcp.existingSession ? (
        <>
          <Menu.Separator />
          <p className="select-none px-2.5 pb-1.5 pt-1.5 text-[11px] leading-snug text-muted-foreground">
            {t('session.mcp.nextStartHint')}
          </p>
        </>
      ) : null}
    </>
  );
}

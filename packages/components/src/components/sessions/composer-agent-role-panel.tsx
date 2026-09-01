import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ban, Check, Plus } from 'lucide-react';
import {
  getAgentRoleEmoji,
  type AgentRoleAvailability,
  type AgentRoleId,
  type MachineViewMeta,
} from '@lody/shared';

import { AgentRoleDetailPane } from '@/components/sessions/agent-role-detail-pane';
import {
  AGENT_ROLE_UNAVAILABLE_REASON_KEYS,
  type ComposerAgentRoleItem,
} from '@/lib/composer-agent-roles';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/ui/dropdown-menu';

/**
 * The Role submenu: the Roles bound to the machine this chat will start on, and
 * what the highlighted one actually runs.
 *
 * Two panes rather than one list because a Role's name is not its
 * configuration. The list is for recognising the Role you meant; the pane
 * beside it states the binding — agent, model, reasoning, permission,
 * instruction — because picking a Role authorizes exactly that and nothing
 * about the name says so.
 */
export function ComposerAgentRolePanel({
  items,
  machine,
  selectedRoleId,
  onSelect,
  onCreate,
  onEdit,
}: {
  items: readonly ComposerAgentRoleItem[];
  /**
   * The machine every listed Role is bound to, passed in rather than looked up:
   * the pane resolves each stored id against that agent's published
   * capabilities, and this component must stay renderable without the
   * workspace's machine-visibility context behind it.
   */
  machine?: MachineViewMeta | null;
  selectedRoleId: AgentRoleId | null;
  /** `null` clears the Role and leaves the configuration exactly as it stands. */
  onSelect: (roleId: AgentRoleId | null) => void;
  onCreate?: () => void;
  onEdit?: (roleId: AgentRoleId) => void;
}) {
  const { t } = useTranslation();
  const [previewRoleId, setPreviewRoleId] = useState<AgentRoleId | null>(null);
  const previewItem =
    items.find((item) => item.role.id === previewRoleId) ??
    items.find((item) => item.role.id === selectedRoleId) ??
    items[0];
  // The Role row turns into a create action instead of opening this submenu
  // when the machine has no Roles, so an empty list never reaches here.
  if (!previewItem) return null;

  return (
    <div className="flex">
      <div className="scrollbar-pro h-[17rem] w-[13.5rem] shrink-0 overflow-y-auto py-1 [scrollbar-gutter:stable]">
        {/* Leaving a Role is its own row rather than a second click on the
            selected one: it clears the NAME, not the configuration, and that is
            not the same gesture as picking. */}
        <DropdownMenuItem
          role="menuitemradio"
          aria-checked={selectedRoleId === null}
          onPointerEnter={() => setPreviewRoleId(null)}
          onSelect={() => onSelect(null)}
        >
          <Ban className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{t('chat.runConfig.roles.none', 'None')}</span>
          {selectedRoleId === null ? (
            <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          ) : null}
        </DropdownMenuItem>
        {items.map((item) => {
          const { role, availability } = item;
          return (
            /* The pointer handler rides a wrapper, not the item: a disabled row
               has `pointer-events-none`, and a Role you cannot pick is still a
               Role whose configuration you may want to read. */
            <div key={role.id} onPointerEnter={() => setPreviewRoleId(role.id)}>
              <DropdownMenuItem
                disabled={availability.kind !== 'available'}
                role="menuitemradio"
                aria-checked={role.id === selectedRoleId}
                className="items-start gap-2"
                onFocus={() => setPreviewRoleId(role.id)}
                onSelect={() => onSelect(role.id)}
              >
                <span className="flex h-4 shrink-0 items-center text-sm leading-none">
                  <span aria-hidden="true">{getAgentRoleEmoji(role)}</span>
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate leading-tight">{role.name}</span>
                  <RoleAvailabilityNote availability={availability} />
                </span>
                {role.id === selectedRoleId ? (
                  <span className="flex h-4 shrink-0 items-center">
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                ) : null}
              </DropdownMenuItem>
            </div>
          );
        })}
        {onCreate ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onCreate}>
              <Plus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">
                {t('chat.runConfig.roles.create', 'New role')}
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
      </div>
      <AgentRoleDetailPane
        role={previewItem.role}
        agentConfig={previewItem.agentConfig}
        machine={machine}
        onEdit={onEdit}
      />
    </div>
  );
}

/**
 * Why this Role cannot be picked, on the row itself.
 *
 * On the row rather than in the detail pane because a disabled row is the one
 * thing a keyboard user cannot bring that pane up for, and a disabled row with
 * no reason reads as a bug. Every reason is shown, `machine_offline` included:
 * unlike the Settings list there is no machine heading above these rows to
 * carry that status.
 */
function RoleAvailabilityNote({ availability }: { availability: AgentRoleAvailability }) {
  const { t } = useTranslation();
  if (availability.kind === 'available') return null;
  if (availability.kind === 'unknown') {
    return (
      <span className="text-[10.5px] leading-snug text-muted-foreground/80">
        {t('settings.agentRoles.status.checking')}
      </span>
    );
  }
  return (
    <span className="text-[10.5px] leading-snug text-status-warning">
      {t(AGENT_ROLE_UNAVAILABLE_REASON_KEYS[availability.reason])}
    </span>
  );
}

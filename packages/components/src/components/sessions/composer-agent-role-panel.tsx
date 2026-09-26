import { useLayoutEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { Ban, Check, Plus } from 'lucide-react';
import {
  getAgentRoleEmoji,
  type AgentRoleAvailability,
  type AgentRoleId,
  type MachineViewMeta,
} from '@lody/shared';

import { composerSurface as surface } from '@/components/shared/composer-surface';
import { AgentRoleDetailPane } from '@/components/sessions/agent-role-detail-pane';
import { useAcpSelectorOptions } from '@/hooks/use-acp-selector-options';
import {
  AGENT_ROLE_UNAVAILABLE_REASON_KEYS,
  type ComposerAgentRoleItem,
} from '@/lib/composer-agent-roles';
import { withClassName } from '@/lib/stylex';
import { Menu } from '@/ui/menu';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';

const styles = stylex.create({
  root: { display: 'flex' },
  list: {
    flexShrink: 0,
    overflowY: 'auto',
    scrollbarGutter: 'stable',
  },
  listCompact: { maxHeight: '17rem', width: '16rem' },
  listTwoPane: { height: '17rem', width: '13.5rem' },
  roleText: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    gap: '2px',
    flexGrow: 1,
    minWidth: 0,
  },
  /** A compact Role is two lines: the row grows past 28px and keeps its words clear. */
  roleTextStacked: { paddingBlock: space[1] },
  subtitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 400,
  },
  /** The create row holds one mark, centred on the row. */
  centered: { display: 'flex', flexGrow: 1, justifyContent: 'center' },
  note: { fontSize: text.captionSize, lineHeight: text.captionLeading, fontWeight: 400 },
  noteChecking: { color: colors.tertiaryLabel },
  noteUnavailable: { color: colors.warning },
});

/** List `13.5rem` + detail pane `16rem`. Below this, the pane cannot fit. */
const TWO_PANE_MIN_PX = 29.5 * 16;

/** Space the Role submenu may still grow into. Prefer Radix's popper var
 *  (set after it positions); fall back to the box's distance to the viewport. */
function remainingWidthForRolePanel(el: HTMLElement): number {
  const fromVar = Number.parseFloat(
    getComputedStyle(el).getPropertyValue('--radix-popper-available-width')
  );
  const host =
    (el.closest('[role="menu"]') as HTMLElement | null) ??
    (el.closest('[data-radix-popper-content-wrapper]') as HTMLElement | null) ??
    el;
  const toViewportRight = window.innerWidth - Math.max(host.getBoundingClientRect().left, 0);
  const candidates = [toViewportRight];
  if (Number.isFinite(fromVar) && fromVar > 0) candidates.push(fromVar);
  return Math.min(...candidates);
}

/**
 * The Role submenu: the Roles bound to the machine this chat will start on, and
 * what the highlighted one actually runs.
 *
 * Two panes rather than one list because a Role's name is not its
 * configuration. The list is for recognising the Role you meant; the pane
 * beside it states the binding — agent, model, reasoning, permission,
 * instruction — because picking a Role authorizes exactly that and nothing
 * about the name says so.
 *
 * When the remaining viewport cannot fit that pane, the list itself carries
 * the binding: each Role is two lines, name then agent · model.
 */
export function ComposerAgentRolePanel({
  items,
  machine,
  selectedRoleId,
  onSelect,
  onCreate,
  onEdit,
  compact: compactOverride,
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
  /** Test/host override. Omit to size from remaining viewport. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  // Start compact so a two-pane first paint cannot overflow before Radix
  // writes `--radix-popper-available-width`. Expand only once that space fits.
  const [detectedCompact, setDetectedCompact] = useState(compactOverride !== false);
  const compact = compactOverride ?? detectedCompact;
  const [previewRoleId, setPreviewRoleId] = useState<AgentRoleId | null>(null);
  const previewItem =
    items.find((item) => item.role.id === previewRoleId) ??
    items.find((item) => item.role.id === selectedRoleId) ??
    items[0];

  useLayoutEffect(() => {
    if (compactOverride != null) {
      setDetectedCompact(compactOverride);
      return undefined;
    }
    const el = rootRef.current;
    if (!el) return undefined;
    let frames = 0;
    let raf = 0;
    const measure = () => {
      setDetectedCompact(remainingWidthForRolePanel(el) < TWO_PANE_MIN_PX);
    };
    const tick = () => {
      measure();
      frames += 1;
      const positioned = getComputedStyle(el).getPropertyValue('--radix-popper-available-width');
      if (frames < 16 && (!positioned || frames < 4)) {
        raf = requestAnimationFrame(tick);
      }
    };
    tick();
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
    };
  }, [compactOverride]);

  // The Role row turns into a create action instead of opening this submenu
  // when the machine has no Roles, so an empty list never reaches here.
  if (!previewItem) return null;

  return (
    <div ref={rootRef} {...stylex.props(styles.root)}>
      {/* `scrollbar-pro` is the app's global scrollbar skin. */}
      <div
        {...withClassName(
          stylex.props(styles.list, compact ? styles.listCompact : styles.listTwoPane),
          'scrollbar-pro'
        )}
      >
        {/* Leaving a Role is its own row rather than a second click on the
            selected one: it clears the NAME, not the configuration, and that is
            not the same gesture as picking. */}
        <Menu.Item
          role="menuitemradio"
          aria-checked={selectedRoleId === null}
          onPointerEnter={() => {
            if (!compact) setPreviewRoleId(null);
          }}
          onClick={() => onSelect(null)}
          icon={<Ban {...stylex.props(surface.glyph16)} aria-hidden="true" />}
          endContent={
            selectedRoleId === null ? (
              <Check {...stylex.props(surface.glyph14)} aria-hidden="true" />
            ) : null
          }
        >
          {t('chat.runConfig.roles.none', 'None')}
        </Menu.Item>
        {items.map((item) => {
          const { role, availability } = item;
          return (
            /* The pointer handler rides a wrapper, not the item: a disabled row
               has `pointer-events-none`, and a Role you cannot pick is still a
               Role whose configuration you may want to read. */
            <div
              key={role.id}
              onPointerEnter={() => {
                if (!compact) setPreviewRoleId(role.id);
              }}
            >
              <Menu.Item
                disabled={availability.kind !== 'available'}
                role="menuitemradio"
                aria-checked={role.id === selectedRoleId}
                onFocus={() => {
                  if (!compact) setPreviewRoleId(role.id);
                }}
                onClick={() => onSelect(role.id)}
                icon={
                  <span {...stylex.props(surface.emoji)} aria-hidden="true">
                    {getAgentRoleEmoji(role)}
                  </span>
                }
                endContent={
                  role.id === selectedRoleId ? (
                    <Check {...stylex.props(surface.glyph14)} aria-hidden="true" />
                  ) : null
                }
              >
                <span {...stylex.props(styles.roleText, compact && styles.roleTextStacked)}>
                  <span {...stylex.props(surface.truncate)}>{role.name}</span>
                  {compact ? <RoleBindingSubtitle item={item} machine={machine} /> : null}
                  <RoleAvailabilityNote availability={availability} />
                </span>
              </Menu.Item>
            </div>
          );
        })}
        {onCreate ? (
          <>
            <Menu.Separator />
            <Menu.Item
              onClick={onCreate}
              aria-label={t(
                'chat.runConfig.roles.createFromSettings',
                'Create role from current settings'
              )}
              title={t(
                'chat.runConfig.roles.createFromSettings',
                'Create role from current settings'
              )}
            >
              <span {...stylex.props(styles.centered)}>
                <Plus {...stylex.props(surface.glyph14, surface.hint)} aria-hidden="true" />
              </span>
            </Menu.Item>
          </>
        ) : null}
      </div>
      {compact ? null : (
        <AgentRoleDetailPane
          role={previewItem.role}
          agentConfig={previewItem.agentConfig}
          machine={machine}
          onEdit={onEdit}
        />
      )}
    </div>
  );
}

/** Compact-row second line: the agent and model this Role would run. */
function RoleBindingSubtitle({
  item,
  machine,
}: {
  item: ComposerAgentRoleItem;
  machine?: MachineViewMeta | null;
}) {
  const { t } = useTranslation();
  const { role, agentConfig } = item;
  const selectorOptions = useAcpSelectorOptions(
    agentConfig
      ? {
          configId: role.agentConfigId,
          cliType: agentConfig.cliType,
          agentType: agentConfig.agentType,
          runtimeOverrides: agentConfig.runtimeOverrides,
          machine: machine ?? null,
        }
      : undefined
  );
  const modelId = role.runConfig.modelId;
  const modelLabel = modelId
    ? (selectorOptions.modelOptions.find((option) => option.value === modelId)?.label ?? modelId)
    : null;
  const agentName = agentConfig?.name ?? t('settings.agentRoles.unknownAgentConfig');
  const parts = [agentName, modelLabel].filter((part): part is string => Boolean(part));
  if (parts.length === 0) return null;
  return <span {...stylex.props(styles.subtitle)}>{parts.join(' · ')}</span>;
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
      <span {...stylex.props(styles.note, styles.noteChecking)}>
        {t('settings.agentRoles.status.checking')}
      </span>
    );
  }
  return (
    <span {...stylex.props(styles.note, styles.noteUnavailable)}>
      {t(AGENT_ROLE_UNAVAILABLE_REASON_KEYS[availability.reason])}
    </span>
  );
}

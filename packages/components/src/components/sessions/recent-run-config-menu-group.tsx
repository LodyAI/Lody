import { ListChecks, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentConfigMeta } from '@lody/shared';

import { AgentIcon } from '@/components/icons/agent-icon';
import { Menu } from '@/ui/menu';

/**
 * "Recently used" run configurations, rendered at the top of
 * `DesktopRunConfigMenu`.
 *
 * A recent entry is one whole combination the user actually started a chat
 * with — agent + model + reasoning + plan/fast, or an Agent Role, which IS one
 * of those combinations — so picking one is a single click instead of walking
 * three submenus. The row therefore reads like the
 * run-config trigger face (icon · model · reasoning · glyphs) and, unlike the
 * Agent/Model/Reasoning option rows, CLOSES the menu: it is a terminal
 * "run it like this" action, not one knob among several.
 *
 * Presentation only. The caller decides which entries exist, drops the one
 * matching the current selection, and caps the list; an empty list renders
 * nothing at all (no label, no separator) so a user who only ever uses one
 * configuration never sees this section.
 */

export type RecentRunConfigItem = {
  /** Stable identity of the combination; also what `onSelect` reports back. */
  id: string;
  agent: Pick<AgentConfigMeta, 'name' | 'cliType' | 'agentType' | 'brandId' | 'env'>;
  /**
   * Present when the chat was started AS a Role. The row then leads with the
   * Role's own mark and name instead of the agent's, because that is what the
   * user picked and what picking the row again does.
   */
  role?: { name: string; emoji: string };
  modelLabel: string | null;
  reasoningLabel: string | null;
  planOn: boolean;
  fastOn: boolean;
};

function RowDot() {
  return (
    <span aria-hidden="true" className="shrink-0 select-none text-muted-foreground/60">
      ·
    </span>
  );
}

/** Flat, comma-free reading of a row for assistive tech and the row tooltip. */
function describeItem(item: RecentRunConfigItem, planLabel: string, fastLabel: string): string {
  return [
    item.role?.name ?? item.agent.name,
    item.modelLabel,
    item.reasoningLabel,
    item.planOn ? planLabel : null,
    item.fastOn ? fastLabel : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function RecentRunConfigMenuGroup({
  items,
  onSelect,
}: {
  items: ReadonlyArray<RecentRunConfigItem>;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (items.length === 0) return null;

  const planLabel = t('chat.mobileNewChat.planModeLabel', 'Plan');
  const fastLabel = t('chat.runConfig.fastLabel', 'Fast');

  return (
    <>
      <Menu.GroupLabel className="text-xs font-normal text-muted-foreground">
        {t('chat.runConfig.recentLabel', 'Recently used')}
      </Menu.GroupLabel>
      {items.map((item) => (
        <Menu.Item
          key={item.id}
          // The row is assembled from several spans, so give Radix an explicit
          // string for typeahead and screen readers instead of the DOM soup.
          label={describeItem(item, planLabel, fastLabel)}
          title={describeItem(item, planLabel, fastLabel)}
          onClick={() => onSelect(item.id)}
          // A recent entry must never set the menu's width: a long agent name
          // would otherwise stretch the whole dropdown and drag the Agent /
          // Model / Reasoning values out to the far edge. Past this cap the
          // row truncates instead of growing.
          className="max-w-80"
        >
          {item.role ? (
            <span className="w-4 shrink-0 text-center text-sm leading-none" aria-hidden="true">
              {item.role.emoji}
            </span>
          ) : (
            <AgentIcon
              cliType={item.agent.cliType}
              agentType={item.agent.agentType}
              brandId={item.agent.brandId}
              env={item.agent.env}
              className="h-4 w-4 shrink-0"
            />
          )}
          {/* Agent holds the left edge; model and reasoning are pushed to a
              right-hand column so all three scan down the list the way the
              Agent / Model / Reasoning rows below this group do. The name takes
              the row's slack and truncates first, because the right column is
              the part a returning user is comparing between rows. */}
          <span className="min-w-0 flex-1 truncate">{item.role?.name ?? item.agent.name}</span>
          {/* No dot between name and model: the separator only reads as one
              phrase while the parts are adjacent, and they no longer are. The
              model keeps its own cap so a long name cannot push it off the cap
              set on the row. */}
          <span className="flex shrink-0 items-center gap-1.5 pl-2 text-xs text-muted-foreground">
            {item.modelLabel ? (
              <span className="min-w-0 max-w-32 truncate">{item.modelLabel}</span>
            ) : null}
            {item.modelLabel && item.reasoningLabel ? <RowDot /> : null}
            {item.reasoningLabel ? <span className="shrink-0">{item.reasoningLabel}</span> : null}
          </span>
          {/* Glyphs park in a right-hand column so plan/fast can be scanned
              down the list instead of hunted at the end of each phrase. */}
          <span className="flex shrink-0 items-center gap-1 pl-2">
            {item.planOn ? (
              <ListChecks
                className="h-3.5 w-3.5 text-primary"
                strokeWidth={1.8}
                aria-hidden="true"
              />
            ) : null}
            {item.fastOn ? (
              <Zap className="h-3.5 w-3.5 text-primary" strokeWidth={1.8} aria-hidden="true" />
            ) : null}
          </span>
        </Menu.Item>
      ))}
      <Menu.Separator />
    </>
  );
}

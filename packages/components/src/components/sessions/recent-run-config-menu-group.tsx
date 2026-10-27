import * as stylex from '@stylexjs/stylex';
import { ListChecks, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentConfigMeta } from '@lody/shared';

import { AgentIcon } from '@/components/icons/agent-icon';
import { Menu } from '@/ui/menu';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontSize, themeLineHeight, themeSpace } from '../../style/theme-scale.stylex';

const styles = stylex.create({
  rowDot: {
    flexShrink: 0,
    userSelect: 'none',
    color: 'hsl(var(--muted-foreground) / 0.6)',
  },
  roleEmoji: {
    width: themeSpace[4],
    flexShrink: 0,
    textAlign: 'center',
    fontSize: themeFontSize.sm,
    lineHeight: '1',
  },
  agentIcon: { height: themeSpace[4], width: themeSpace[4], flexShrink: 0 },
  name: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  valueColumn: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[1.5],
    paddingLeft: themeSpace[2],
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },
  modelName: {
    minWidth: 0,
    maxWidth: '8rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  reasoningName: { flexShrink: 0 },
  glyphColumn: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[1],
    paddingLeft: themeSpace[2],
  },
  glyph: { height: themeSpace[3.5], width: themeSpace[3.5], color: themeColors.primary },
});

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
    <span aria-hidden="true" {...stylex.props(styles.rowDot)}>
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
      {/* The heading keeps its Tailwind classes: it overrides the shared menu
          heading's own StyleX tokens, and a StyleX class here would lose to
          them (both land in the same stylesheet). */}
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
            <span {...stylex.props(styles.roleEmoji)} aria-hidden="true">
              {item.role.emoji}
            </span>
          ) : (
            <AgentIcon
              cliType={item.agent.cliType}
              agentType={item.agent.agentType}
              brandId={item.agent.brandId}
              env={item.agent.env}
              className={stylex.props(styles.agentIcon).className}
            />
          )}
          {/* Agent holds the left edge; model and reasoning are pushed to a
              right-hand column so all three scan down the list the way the
              Agent / Model / Reasoning rows below this group do. The name takes
              the row's slack and truncates first, because the right column is
              the part a returning user is comparing between rows. */}
          <span {...stylex.props(styles.name)}>{item.role?.name ?? item.agent.name}</span>
          {/* No dot between name and model: the separator only reads as one
              phrase while the parts are adjacent, and they no longer are. The
              model keeps its own cap so a long name cannot push it off the cap
              set on the row. */}
          <span {...stylex.props(styles.valueColumn)}>
            {item.modelLabel ? (
              <span {...stylex.props(styles.modelName)}>{item.modelLabel}</span>
            ) : null}
            {item.modelLabel && item.reasoningLabel ? <RowDot /> : null}
            {item.reasoningLabel ? (
              <span {...stylex.props(styles.reasoningName)}>{item.reasoningLabel}</span>
            ) : null}
          </span>
          {/* Glyphs park in a right-hand column so plan/fast can be scanned
              down the list instead of hunted at the end of each phrase. */}
          <span {...stylex.props(styles.glyphColumn)}>
            {item.planOn ? (
              <ListChecks {...stylex.props(styles.glyph)} strokeWidth={1.8} aria-hidden="true" />
            ) : null}
            {item.fastOn ? (
              <Zap {...stylex.props(styles.glyph)} strokeWidth={1.8} aria-hidden="true" />
            ) : null}
          </span>
        </Menu.Item>
      ))}
      <Menu.Separator />
    </>
  );
}

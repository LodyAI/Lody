import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { homeNowInputAtom } from '@/atoms/home-now';
import { homeWeekInputAtom } from '@/atoms/home-week';
import { AgentIcon, getAgentDisplayName } from '@/components/icons/agent-icon';
import { useCodexResetForecast } from '@/hooks/use-codex-reset-forecast';
import { useStableNow } from '@/hooks/use-stable-now';
import { formatCodexResetExpiry } from '@/lib/codex-reset-forecast';
import {
  HOME_BOARD_KEY,
  parseHomeBoard,
  serializeHomeBoard,
  type HomeBoard,
} from '@/lib/home-board';
import { buildHomeNow } from '@/lib/home-now';
import { buildHomeWeek, type HomeWeekAgent } from '@/lib/home-week';
import type { HomeWeekForecast, HomeWeekUsageOption } from '@/lib/home-week-usage';
import type { AgentConfigCliType } from '@lody/shared';
import { HomeDashboard } from './home-dashboard';

/** Ages on the "now" board read in minutes, so the clock only needs to be roughly current. */
const NOW_INTERVAL_MS = 60_000;

function readBoard(): HomeBoard | null {
  try {
    return parseHomeBoard(localStorage.getItem(HOME_BOARD_KEY));
  } catch {
    return parseHomeBoard(null);
  }
}

/** The open board, remembered on this device. */
function useHomeBoard(onChange?: (board: HomeBoard | null) => void) {
  const [board, setBoard] = useState<HomeBoard | null>(readBoard);
  const change = useCallback(
    (next: HomeBoard | null) => {
      setBoard(next);
      try {
        localStorage.setItem(HOME_BOARD_KEY, serializeHomeBoard(next));
      } catch {
        // Storage can be unavailable; the choice still holds for this visit.
      }
      onChange?.(next);
    },
    [onChange]
  );
  return [board, change] as const;
}

/**
 * The new-chat page's two boards wired to what the client already holds: the session metadata
 * and presence for "now", the same metadata for the last seven days, and the plan usage of
 * every provider the landing found on the selected machine. The usage shows the provider the
 * composer has selected until the user picks another; that pick stays for this visit. Kept
 * apart from `HomeDashboard` so the boards stay a pure picture (and Storybook can hand them
 * anything).
 *
 * The Codex reset forecast is the one place that loads when it mounts
 * (`components/codex-reset/AGENTS.md`): only while the "now" board (which holds the usage) is
 * open, and only for a first-party Codex provider. The shared store coalesces and revalidates,
 * so coming back to the page is usually a 304 or no request at all.
 */
export function HomeDashboardHost({
  usageOptions = [],
  composerAgentId = null,
  onOpenSession,
  onBoardChange,
}: {
  usageOptions?: readonly HomeWeekUsageOption[];
  /** The agent configuration the composer has selected. */
  composerAgentId?: string | null;
  onOpenSession?: (sessionId: string) => void;
  /** Notifies when the open board changes (null when everything is folded). */
  onBoardChange?: (board: HomeBoard | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const weekInput = useAtomValue(homeWeekInputAtom);
  const nowInput = useAtomValue(homeNowInputAtom);
  const clock = useStableNow(NOW_INTERVAL_MS);
  const nowMs = clock.getTime();
  const week = useMemo(() => buildHomeWeek(weekInput, clock), [weekInput, clock]);
  const now = useMemo(() => buildHomeNow(nowInput, nowMs), [nowInput, nowMs]);
  const [board, setBoard] = useHomeBoard(onBoardChange);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const active =
    usageOptions.find((option) => option.source.id === pickedId) ??
    usageOptions.find((option) => option.source.id === composerAgentId) ??
    usageOptions[0] ??
    null;
  const usageSources = useMemo(() => usageOptions.map((option) => option.source), [usageOptions]);
  // Folded, or on the week, no reset is shown, so the third-party forecast is not asked for.
  const showCodexResetForecast = active?.codexForecast === true && board === 'now';
  const forecast = useCodexResetForecast(showCodexResetForecast);
  const { revalidate } = forecast;
  useEffect(() => {
    if (showCodexResetForecast) revalidate();
  }, [showCodexResetForecast, revalidate]);
  const agentLabel = useCallback(
    (agent: HomeWeekAgent) =>
      getAgentDisplayName(agent.cliType as AgentConfigCliType, agent.agentType) ?? agent.agentType,
    []
  );
  const agentIcon = useCallback(
    (agent: { cliType: string; agentType: string }) => (
      <AgentIcon
        cliType={agent.cliType as AgentConfigCliType}
        agentType={agent.agentType}
        className="size-4"
      />
    ),
    []
  );

  const scheduled = showCodexResetForecast ? (forecast.state.data?.scheduledReset ?? null) : null;
  const watch = showCodexResetForecast ? forecast.watch : null;
  let forecastLine: HomeWeekForecast | null = null;
  if (scheduled || watch) {
    const timeMs = scheduled ? scheduled.scheduledForMs : watch!.expiresAtMs;
    const when =
      timeMs === null
        ? t('codexReset.scheduleUnknown', 'Time not yet specified')
        : scheduled && timeMs <= forecast.nowMs
          ? t('codexReset.awaitingExecution', 'Awaiting confirmation of execution')
          : formatCodexResetExpiry(timeMs, forecast.nowMs, i18n.resolvedLanguage ?? i18n.language);
    // Named for the provider it is about: the tile sits beside the usage of whichever one is chosen.
    const title = scheduled
      ? t('home.week.forecastScheduled', 'Codex reset scheduled')
      : t('codexReset.title', 'Codex reset forecast');
    forecastLine = {
      title,
      chancePercent: !scheduled && watch?.chancePercent != null ? watch.chancePercent : null,
      when,
    };
  }

  return (
    <HomeDashboard
      board={board}
      onBoardChange={setBoard}
      now={now}
      week={week}
      agentLabel={agentLabel}
      agentIcon={agentIcon}
      nowMs={nowMs}
      onOpenSession={onOpenSession}
      usage={active?.usage ?? null}
      usageSources={usageSources}
      usageSourceId={active?.source.id ?? null}
      onUsageSourceChange={setPickedId}
      forecast={forecastLine}
    />
  );
}

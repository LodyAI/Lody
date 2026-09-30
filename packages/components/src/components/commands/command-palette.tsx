import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from '@tanstack/react-router';
import { useAtomValue } from 'jotai';
import type { SessionId } from '@lody/shared';
import {
  commands,
  useCommandPaletteState,
  useCommands,
  type Command,
  type CommandCategory,
} from '@/lib/commands';
import { currentWorkspaceSlugAtom } from '@/atoms';
import { useVisibleSessionMetas } from '@/hooks/use-visible-session-metas';
import { useVisibleLocalProjects } from '@/hooks/use-visible-local-projects';
import { useStableNow } from '@/hooks/use-stable-now';
import type { SessionListEntry } from '@/lib/session-visibility';
import { formatCompactRelativeTime } from '@/lib/format-relative-time';
import { CommandPaletteView, type PaletteResult } from './command-palette-view';
import { COMMAND_ICONS } from './command-icons';
import {
  getSessionPaletteSubtitle,
  resolveSessionProjectLabel,
} from './command-palette-session-result';
import { fuzzyMatch } from './fuzzy-match';

// Default ordering for the no-query view (flat list, no group headings).
const CATEGORY_ORDER: CommandCategory[] = [
  'Navigation',
  'Session',
  'Editor',
  'View',
  'Workspace',
  'Help',
  'Other',
];

const MAX_SESSION_RESULTS = 8;

export function CommandPalette() {
  const { t } = useTranslation();
  const router = useRouter();
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const [open, setOpen] = useCommandPaletteState();
  const [query, setQuery] = useState('');
  const all = useCommands();
  const { sessions } = useVisibleSessionMetas();
  const { projects: localProjects } = useVisibleLocalProjects({ syncMachineFlock: false });
  // Stable clock for the compact last-activity labels (updates ~once a minute).
  const now = useStableNow();

  const trimmedQuery = query.trim();
  const isSearching = trimmedQuery.length > 0;

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) setQuery('');
    },
    [setOpen]
  );

  const runCommand = useCallback(
    (id: string) => {
      handleOpenChange(false);
      commands.execute(id);
    },
    [handleOpenChange]
  );

  const openSession = useCallback(
    (sessionId: SessionId) => {
      if (!workspaceSlug) return;
      handleOpenChange(false);
      void router.navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: workspaceSlug, sessionId },
      });
    },
    [handleOpenChange, router, workspaceSlug]
  );

  const resolveLabel = useCallback(
    (cmd: Command) => (cmd.titleKey ? t(cmd.titleKey, { defaultValue: cmd.title }) : cmd.title),
    [t]
  );

  const toCommandResult = useCallback(
    (cmd: Command, grouped = false): PaletteResult => ({
      kind: 'command',
      key: `command:${cmd.id}`,
      title: resolveLabel(cmd),
      subtitle: null,
      shortcut: commands.getKeybindingsFor(cmd.id)[0] ?? null,
      icon: COMMAND_ICONS[cmd.id],
      group: grouped
        ? t(`settings.keyboardShortcuts.category.${cmd.category ?? 'Other'}`, {
            defaultValue: cmd.category ?? 'Other',
          })
        : undefined,
      run: () => runCommand(cmd.id),
    }),
    [resolveLabel, runCommand, t]
  );

  const toSessionResult = useCallback(
    (session: SessionListEntry): PaletteResult => {
      const lastActivityValue = session.lastMessageAt ?? session.createdAt ?? null;
      return {
        kind: 'session',
        key: `session:${session.id}`,
        title: session.title?.trim() || t('sessions.untitled', 'Untitled session'),
        subtitle: getSessionPaletteSubtitle(session, localProjects),
        shortcut: null,
        trailing:
          lastActivityValue != null ? formatCompactRelativeTime(lastActivityValue, now) : null,
        run: () => openSession(session.id),
      };
    },
    [localProjects, now, openSession, t]
  );

  // Only surface commands that can actually fire in the current view. Each command declares
  // a `when()` predicate (built-in placeholders use `when: () => false`; session actions gate
  // on an active session), so the palette respects it the way VS Code's does. Re-evaluated
  // whenever the registry changes or the palette (re)opens — `open` in the deps refreshes the
  // predicates at open time. The keyboard-shortcuts settings page is unaffected (it lists all
  // commands so they stay rebindable even when inactive).
  const visibleCommands = useMemo(
    () => (open ? all.filter((cmd) => !cmd.hidden && isCommandAvailable(cmd)) : []),
    [all, open]
  );

  // Single flat, relevance-ordered result list — no category groups. With no query we show
  // commands in a sensible default order; while searching, commands and conversations are
  // scored by the same fuzzy matcher and interleaved purely by score.
  const results = useMemo<PaletteResult[]>(() => {
    if (!isSearching) {
      const rank = (c?: CommandCategory) => {
        const i = CATEGORY_ORDER.indexOf(c ?? 'Other');
        return i === -1 ? CATEGORY_ORDER.length : i;
      };
      return [...visibleCommands]
        .sort(
          (a, b) =>
            rank(a.category) - rank(b.category) || resolveLabel(a).localeCompare(resolveLabel(b))
        )
        .map((cmd) => toCommandResult(cmd, true));
    }

    const scored: Array<{ result: PaletteResult; score: number }> = [];

    for (const cmd of visibleCommands) {
      const score = fuzzyMatch(trimmedQuery, `${resolveLabel(cmd)} ${cmd.id}`);
      if (score !== null) scored.push({ result: toCommandResult(cmd), score });
    }

    const sessionScored: Array<{ result: PaletteResult; score: number }> = [];
    for (const session of sessions) {
      let best: number | null = null;
      // Match the displayed project/repo label too (covers local project names, not
      // just `repoFullName`), so a session is findable by what the row shows.
      const projectLabel = resolveSessionProjectLabel(session, localProjects) ?? '';
      for (const text of [session.title ?? '', projectLabel, session.branchName ?? '']) {
        if (!text) continue;
        const score = fuzzyMatch(trimmedQuery, text);
        if (score !== null && (best === null || score > best)) best = score;
      }
      if (best !== null) sessionScored.push({ result: toSessionResult(session), score: best });
    }
    sessionScored.sort((a, b) => b.score - a.score);

    return [...scored, ...sessionScored.slice(0, MAX_SESSION_RESULTS)]
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.result);
  }, [
    isSearching,
    localProjects,
    resolveLabel,
    sessions,
    toCommandResult,
    toSessionResult,
    trimmedQuery,
    visibleCommands,
  ]);

  const labels = useMemo(
    () => ({
      placeholder: t('commands.palette.placeholder', {
        defaultValue: 'Search commands and chats...',
      }),
      empty: t('commands.palette.empty', { defaultValue: 'No results found.' }),
      navigate: t('commands.palette.hintNavigate', { defaultValue: 'Navigate' }),
      select: t('commands.palette.hintSelect', { defaultValue: 'Select' }),
      close: t('commands.palette.hintClose', { defaultValue: 'Close' }),
    }),
    [t]
  );

  return (
    <CommandPaletteView
      open={open}
      onOpenChange={handleOpenChange}
      query={query}
      onQueryChange={setQuery}
      results={results}
      labels={labels}
    />
  );
}

/**
 * Whether a command is actionable right now. Commands with no `when` are always available;
 * otherwise the predicate decides. A throwing predicate is treated as unavailable rather than
 * crashing the palette (matches the registry's defensive dispatch).
 */
function isCommandAvailable(cmd: Command): boolean {
  if (!cmd.when) return true;
  try {
    return cmd.when();
  } catch {
    return false;
  }
}

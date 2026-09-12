import type { ConversationMarkdownStats } from '@lody/shared';

/** Keep every budget/truncation notice identical in the app and anonymous reader. */
export function describeCopiedConversation(
  stats: ConversationMarkdownStats,
  t: (key: string, fallback: string, options?: Record<string, unknown>) => string
): string {
  if (stats.overBudget) {
    return t(
      'sessions.copyConversationHistoryCopiedOverBudget',
      'Conversation copied as Markdown (~{{tokens}}k tokens — message text alone exceeds the target)',
      { tokens: Math.round(stats.estimatedTokens / 1000) }
    );
  }

  const trimmed: string[] = [];
  if (stats.toolCallsCollapsed) {
    trimmed.push(t('sessions.copyConversationHistoryTrimToolCalls', 'tool call details'));
  }
  if (stats.thinkingTruncated) {
    trimmed.push(t('sessions.copyConversationHistoryTrimThinking', 'thinking'));
  }
  if (stats.terminalOutputOmitted || stats.terminalOutputTruncated) {
    trimmed.push(t('sessions.copyConversationHistoryTrimTerminal', 'terminal output'));
  }
  if (stats.toolResultsTruncated > 0) {
    trimmed.push(
      // `value`, not `count`: `count` would send i18next down its plural-key
      // lookup (`..._one` / `..._other`), which these strings do not define.
      t('sessions.copyConversationHistoryTrimToolResults', '{{value}} tool results', {
        value: stats.toolResultsTruncated,
      })
    );
  }

  if (trimmed.length === 0) {
    return t('sessions.copyConversationHistoryCopied', 'Conversation copied as Markdown');
  }
  return t(
    'sessions.copyConversationHistoryCopiedTrimmed',
    'Conversation copied as Markdown (trimmed: {{omitted}})',
    { omitted: trimmed.join(', ') }
  );
}

import { useId, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { control } from '@lody/ui/tokens/scales.stylex';
import { styles as taskStyles } from './subagent-task-panel.stylex';
import { ChevronRight, GitBranchPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ComponentProps } from 'react';
import type { SessionHistoryParsed } from '@lody/shared';
import { withClassName } from '@/lib/stylex';
import { CreatedSessionOperationCard } from './created-session-operation-card';

type Card = Omit<ComponentProps<typeof CreatedSessionOperationCard>, 'onNavigateSession'>;

/** Only pure creation records may coalesce; notices and failures keep their own rows. */
export function getCreatedSessionCards(message: SessionHistoryParsed): Card[] | null {
  if (message.role !== 'system') return null;
  const cards: Card[] = [];
  for (const item of message.items) {
    if (item.type === 'operation_progress') {
      cards.push(
        ...item.items.map((entry) => ({
          sessionId: entry.target.sessionId,
          fallbackTitle: entry.label,
          status: entry.status,
        }))
      );
    } else if (
      item.type === 'operation_completion' &&
      (item.operationKind === 'session_create' || item.operationKind === 'session_create_many') &&
      !item.progressMessageId &&
      !item.continuation &&
      item.completion.type === 'result' &&
      item.completion.value.items.length > 0
    ) {
      for (const entry of item.completion.value.items) {
        if (!entry.target || entry.status !== 'succeeded') return null;
        cards.push({
          sessionId: entry.target.sessionId,
          fallbackTitle: entry.label,
          status: entry.status,
          detail: summarizeOperationOutput(entry.output?.text),
        });
      }
    } else return null;
  }
  return cards.length ? cards : null;
}

const styles = stylex.create({
  header: { display: 'grid', minWidth: 0 },
  headerLabel: { flexGrow: 1, textAlign: 'start' },
  list: { minWidth: 0, scrollbarGutter: 'stable', overscrollBehaviorY: 'contain' },
  bounded: {
    // Five compact control rows, with four separators.
    maxHeight: `calc(5 * ${control.small} + 4px)`,
  },
});

export function CreatedSessionList({
  cards,
  onNavigateSession,
}: {
  cards: readonly Card[];
  onNavigateSession?: ComponentProps<typeof CreatedSessionOperationCard>['onNavigateSession'];
}) {
  const { t } = useTranslation();
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const overflowing = cards.length > 5;
  if (cards.length === 0) return null;
  return (
    <div {...stylex.props(taskStyles.panel)} data-created-session-list="">
      {overflowing ? (
        <div {...stylex.props(styles.header)}>
          <Button
            variant="ghost"
            size="small"
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => setExpanded((value) => !value)}
          >
            <span {...stylex.props(taskStyles.line)}>
              <ChevronRight
                aria-hidden="true"
                {...stylex.props(taskStyles.chevron, expanded && taskStyles.chevronOpen)}
              />
              <span {...stylex.props(styles.headerLabel)}>
                {t(
                  expanded
                    ? 'sessions.openedBy.collapseChildren'
                    : 'sessions.openedBy.expandChildren',
                  { count: cards.length }
                )}
              </span>
            </span>
          </Button>
        </div>
      ) : (
        <div {...stylex.props(taskStyles.header)}>
          <GitBranchPlus aria-hidden="true" {...stylex.props(taskStyles.glyph)} />
          <span>{t('sessions.openedBy.childCount', { count: cards.length })}</span>
        </div>
      )}
      <div
        id={id}
        {...withClassName(
          stylex.props(taskStyles.rows, styles.list, overflowing && !expanded && styles.bounded),
          'scrollbar-pro'
        )}
        data-vaul-no-drag=""
        tabIndex={overflowing ? 0 : undefined}
        role="region"
        aria-label={t('sessions.openedBy.childCount', { count: cards.length })}
      >
        {cards.map((card, index) => (
          <div
            key={`${card.sessionId}-${index}`}
            {...stylex.props(index > 0 && taskStyles.rowRuled)}
          >
            <CreatedSessionOperationCard {...card} onNavigateSession={onNavigateSession} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** One readable line from a reply preview: collapsed whitespace, capped length. */
export const summarizeOperationOutput = (text: string | undefined): string | undefined => {
  const collapsed = text?.replace(/\s+/g, ' ').trim();
  if (!collapsed) return undefined;
  return collapsed.length > 240 ? `${collapsed.slice(0, 240)}…` : collapsed;
};

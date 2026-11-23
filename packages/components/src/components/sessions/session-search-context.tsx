import { createContext, useContext, useMemo, type ReactNode, Fragment } from 'react';
import { cn } from '@/lib/utils';
import { buildSessionSearchTextParts } from '@/lib/session-chat-search';

export type SessionSearchBlockMatch = {
  blockId: string;
  resultIds: string[];
  activeResultId: string | null;
  activeOccurrenceIndex: number | null;
};

type SessionSearchContextValue = {
  isOpen: boolean;
  query: string;
  activeBlockId: string | null;
  activeResultId: string | null;
  blockMatches: ReadonlyMap<string, SessionSearchBlockMatch>;
  hasMatchedPrefix: (prefix: string) => boolean;
  hasActivePrefix: (prefix: string) => boolean;
};

const SessionSearchContext = createContext<SessionSearchContextValue | null>(null);

export const SEARCH_HIGHLIGHT_MARK_CLASS_NAME =
  'rounded-xs bg-amber-200/75 text-foreground shadow-[inset_0_-1px_0_rgba(0,0,0,0.12)] dark:bg-amber-400/25';

export const SEARCH_HIGHLIGHT_ACTIVE_MARK_CLASS_NAME =
  'bg-amber-300 text-foreground ring-1 ring-amber-400/80 dark:bg-amber-300/55 dark:ring-amber-200/60';

export const SEARCH_HIGHLIGHT_CONTAINER_MATCHED_CLASS_NAME = '';

export const SEARCH_HIGHLIGHT_CONTAINER_ACTIVE_CLASS_NAME =
  'ring-1 ring-primary/25 shadow-[0_0_0_1px_rgba(15,23,42,0.04)] dark:ring-white/15 dark:shadow-none';

export function SessionSearchProvider({
  value,
  children,
}: {
  value: SessionSearchContextValue;
  children: ReactNode;
}) {
  return <SessionSearchContext.Provider value={value}>{children}</SessionSearchContext.Provider>;
}

export const useSessionSearch = () => useContext(SessionSearchContext);

export const useSessionSearchBlock = (blockId: string): SessionSearchBlockMatch | null => {
  const context = useSessionSearch();
  return context?.blockMatches.get(blockId) ?? null;
};

export const useSessionSearchBlockPrefix = (prefix: string) => {
  const context = useSessionSearch();
  return useMemo(
    () => ({
      hasMatched: context?.hasMatchedPrefix(prefix) ?? false,
      hasActive: context?.hasActivePrefix(prefix) ?? false,
    }),
    [context, prefix]
  );
};

export const SearchHighlightedText = ({
  blockId,
  text,
  className,
}: {
  blockId: string;
  text: string;
  className?: string;
}) => {
  const context = useSessionSearch();
  const match = useSessionSearchBlock(blockId);

  const parts = useMemo(() => {
    if (!context?.isOpen || !match || !context.query) {
      return null;
    }
    return buildSessionSearchTextParts({
      text,
      query: context.query,
      resultIds: match.resultIds,
      activeOccurrenceIndex: match.activeOccurrenceIndex,
    });
  }, [context, match, text]);

  if (!parts) {
    return <span className={className}>{text}</span>;
  }

  return (
    <span className={className} data-search-block-id={blockId}>
      {parts.map((part, index) => {
        if (!part.isMatch) {
          return <Fragment key={`text-${index}`}>{part.text}</Fragment>;
        }
        return (
          <mark
            key={`mark-${part.resultId ?? index}`}
            data-search-result-id={part.resultId ?? undefined}
            className={cn(
              SEARCH_HIGHLIGHT_MARK_CLASS_NAME,
              part.isActive && SEARCH_HIGHLIGHT_ACTIVE_MARK_CLASS_NAME
            )}
          >
            {part.text}
          </mark>
        );
      })}
    </span>
  );
};

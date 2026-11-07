import { clsx } from 'clsx';
import { createContext, useContext, useMemo, type ReactNode, Fragment } from 'react';
import * as stylex from '@stylexjs/stylex';
import { buildSessionSearchTextParts } from '@/lib/session-chat-search';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeRadius } from '../../style/theme-scale.stylex';

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

const DARK_SCOPE =
  ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))';

const styles = stylex.create({
  mark: {
    borderRadius: themeRadius.xs,
    backgroundColor: {
      default: 'color-mix(in oklab, var(--color-amber-200) 75%, transparent)',
      [DARK_SCOPE]: 'color-mix(in oklab, var(--color-amber-400) 25%, transparent)',
      ':is(.lody-session-search-active)': {
        default: 'var(--color-amber-300)',
        [DARK_SCOPE]: 'color-mix(in oklab, var(--color-amber-300) 55%, transparent)',
      },
    },
    boxShadow: {
      default: 'inset 0 -1px 0 rgba(0, 0, 0, 0.12)',
      ':is(.lody-session-search-active)': {
        default:
          '0 0 0 1px color-mix(in oklab, var(--color-amber-400) 80%, transparent), inset 0 -1px 0 rgba(0, 0, 0, 0.12)',
        [DARK_SCOPE]:
          '0 0 0 1px color-mix(in oklab, var(--color-amber-200) 60%, transparent), inset 0 -1px 0 rgba(0, 0, 0, 0.12)',
        ':focus-visible': 'inset 0 -1px 0 rgba(0, 0, 0, 0.12)',
      },
    },
  },
  ink: { color: themeColors.foreground },
  activeContainer: {
    boxShadow: {
      default:
        '0 0 0 1px color-mix(in oklab, hsl(var(--primary) / 1) 25%, transparent), 0 0 0 1px rgba(15, 23, 42, 0.04)',
      [DARK_SCOPE]: '0 0 0 1px color-mix(in oklab, var(--color-white) 15%, transparent)',
      ':focus-visible': { default: '0 0 0 1px rgba(15, 23, 42, 0.04)', [DARK_SCOPE]: 'none' },
    },
  },
});

// Markdown inserts the same mark classes as the React text renderer. The active
// hook selects the palette inside the mark's one StyleX declaration.
export const SEARCH_HIGHLIGHT_MARK_CLASS_NAME =
  stylex.props(styles.mark, styles.ink).className ?? '';
export const SEARCH_HIGHLIGHT_ACTIVE_MARK_CLASS_NAME = 'lody-session-search-active';
export const SEARCH_HIGHLIGHT_CONTAINER_MATCHED_CLASS_NAME = '';
export const SEARCH_HIGHLIGHT_CONTAINER_ACTIVE_CLASS_NAME = stylex.props(
  styles.activeContainer
).className;

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
            className={clsx(
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

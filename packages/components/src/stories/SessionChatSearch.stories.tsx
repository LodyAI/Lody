import type { Meta, StoryObj } from '@storybook/react';
import type { SessionHistory, SessionHistoryParsed, SessionId } from '@lody/shared';
import { useMemo, useRef, useState } from 'react';
import type { ChatStreamItem, SessionChatStreamViewProps } from '@/components/ai-gui/view';
import { MessageRowView, SessionChatStreamView } from '@/components/ai-gui/view';
import { SessionSearchBar } from '@/components/sessions/session-chat-interface';
import { SessionSearchProvider } from '@/components/sessions/session-search-context';
import {
  buildSessionSearchResults,
  extractSessionSearchBlocks,
  normalizeSessionSearchQuery,
  type SessionSearchBlock,
  type SessionSearchResult,
} from '@/lib/session-chat-search';
import { useTranslation } from 'react-i18next';

const meta = {
  title: 'Sessions/SessionChatSearch',
  component: SessionChatStreamView,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof SessionChatStreamView>;

export default meta;
type Story = StoryObj<typeof meta>;

const sessionId = 'session-search-storybook' as SessionId;

const buildItems = (messages: SessionHistoryParsed[]): ChatStreamItem[] =>
  messages.map((message, turnIndex) => ({ type: 'message', sessionId, message, turnIndex }) as const);

const renderMessageRow: SessionChatStreamViewProps['renderMessageRow'] = ({
  message,
  sessionId: storySessionId,
}) => <MessageRowView message={message} sessionId={storySessionId} />;

const buildMessage = (
  overrides: Partial<SessionHistoryParsed> & Pick<SessionHistoryParsed, 'id' | 'items'>
): SessionHistoryParsed => ({
  id: overrides.id,
  role: overrides.role ?? 'assistant',
  timestamp: overrides.timestamp ?? '2026-04-10T09:00:00.000Z',
  read: overrides.read ?? true,
  userId: overrides.userId,
  userTurnId: overrides.userTurnId,
  items: overrides.items,
  fileDiff: overrides.fileDiff,
  finished: overrides.finished,
  modelInfo: overrides.modelInfo,
  plan: overrides.plan,
  endedAt: overrides.endedAt,
});

const searchMessages: SessionHistoryParsed[] = [
  buildMessage({
    id: 'search-user',
    role: 'user',
    userId: 'storybook-user',
    timestamp: '2026-04-10T09:00:00.000Z',
    items: [
      {
        type: 'text',
        text: 'Please search the session for rg results and the edited search component.',
      },
    ],
  }),
  buildMessage({
    id: 'search-assistant-1',
    role: 'assistant',
    timestamp: '2026-04-10T09:00:10.000Z',
    items: [
      {
        type: 'thought',
        text: 'Search should expand collapsed cards before focusing the active rg result.',
      },
      {
        type: 'text',
        text: [
          'I indexed the session history and highlighted every visible `rg` match.',
          '',
          '- Search results are occurrence-based.',
          '- Only conversation text is indexed; the tool call below is not searchable.',
        ].join('\n'),
      },
      {
        type: 'tool_call',
        toolCallId: 'tool-search-story',
        title: 'Run rg session-chat-search',
        kind: 'execute',
        status: 'completed',
        locations: [{ path: '/repo/packages/components/src/lib/session-chat-search.ts' }],
        rawOutput: { summary: 'rg found 4 search matches' },
        content: [
          {
            type: 'terminal_command',
            command: '/bin/zsh',
            args: ['-lc', 'rg "search" packages/components/src'],
            cwd: '/repo',
          },
          {
            type: 'terminal_output',
            stream: 'combined',
            output: [
              'packages/components/src/lib/session-chat-search.ts: buildSessionSearchResults',
              'packages/components/src/components/sessions/session-chat-interface.tsx: SessionSearchBar',
              'packages/components/src/components/ai-gui/view.tsx: SearchHighlightedText',
            ].join('\n'),
            exitStatus: { exitCode: 0, signal: null },
          },
          {
            type: 'diff',
            path: '/repo/packages/components/src/components/sessions/session-chat-interface.tsx',
            oldText: 'const currentLabel = "0 / 0";',
            newText: 'const currentLabel = "2 / 6";',
          },
        ],
      },
    ],
  }),
  buildMessage({
    id: 'search-assistant-2',
    role: 'assistant',
    timestamp: '2026-04-10T09:00:20.000Z',
    items: [
      {
        type: 'text',
        text: 'Use Enter for next result and Shift+Enter for the previous result.',
      },
    ],
  }),
];

interface SearchStoryPreviewProps {
  initialQuery?: string;
  initialActiveIndex?: number;
  forceTotalCount?: number;
  showChatBackdrop?: boolean;
  height?: number;
}

function SearchStoryPreview({
  initialQuery = 'search',
  initialActiveIndex = 1,
  forceTotalCount,
  showChatBackdrop = true,
  height = 780,
}: SearchStoryPreviewProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const [activeSearchResultIndex, setActiveSearchResultIndex] = useState(initialActiveIndex);

  const searchBlocks = useMemo<SessionSearchBlock[]>(
    () => extractSessionSearchBlocks(searchMessages as unknown as SessionHistory[]),
    []
  );
  const normalizedSearchQuery = useMemo(() => normalizeSessionSearchQuery(query), [query]);
  const computedResults = useMemo<SessionSearchResult[]>(
    () => buildSessionSearchResults(searchBlocks, normalizedSearchQuery),
    [normalizedSearchQuery, searchBlocks]
  );
  const searchResults = useMemo<SessionSearchResult[]>(
    () => (forceTotalCount !== undefined ? [] : computedResults),
    [forceTotalCount, computedResults]
  );
  const effectiveTotalCount =
    forceTotalCount !== undefined ? forceTotalCount : searchResults.length;
  const effectiveActiveIndex =
    effectiveTotalCount > 0
      ? Math.min(activeSearchResultIndex, Math.max(effectiveTotalCount - 1, 0))
      : 0;
  const activeSearchResult = searchResults[effectiveActiveIndex] ?? null;
  const searchBlockMatches = useMemo(() => {
    const next = new Map<
      string,
      {
        blockId: string;
        resultIds: string[];
        activeResultId: string | null;
        activeOccurrenceIndex: number | null;
      }
    >();

    searchResults.forEach((result) => {
      const existing = next.get(result.blockId);
      if (existing) {
        existing.resultIds.push(result.resultId);
        if (activeSearchResult?.resultId === result.resultId) {
          existing.activeResultId = result.resultId;
          existing.activeOccurrenceIndex = result.localIndex;
        }
        return;
      }

      next.set(result.blockId, {
        blockId: result.blockId,
        resultIds: [result.resultId],
        activeResultId: activeSearchResult?.resultId === result.resultId ? result.resultId : null,
        activeOccurrenceIndex:
          activeSearchResult?.resultId === result.resultId ? result.localIndex : null,
      });
    });

    return next;
  }, [activeSearchResult?.resultId, searchResults]);
  const searchContextValue = useMemo(() => {
    const isSearchActive = normalizedSearchQuery.length > 0;
    const matchedBlockIds = isSearchActive ? Array.from(searchBlockMatches.keys()) : [];
    const activeBlockId = isSearchActive ? (activeSearchResult?.blockId ?? null) : null;

    return {
      isOpen: isSearchActive,
      query: isSearchActive ? normalizedSearchQuery : '',
      activeBlockId,
      activeResultId: isSearchActive ? (activeSearchResult?.resultId ?? null) : null,
      blockMatches: isSearchActive ? searchBlockMatches : new Map(),
      hasMatchedPrefix: (prefix: string) =>
        matchedBlockIds.some((blockId) => blockId === prefix || blockId.startsWith(`${prefix}:`)),
      hasActivePrefix: (prefix: string) =>
        activeBlockId !== null &&
        (activeBlockId === prefix || activeBlockId.startsWith(`${prefix}:`)),
    };
  }, [
    activeSearchResult?.blockId,
    activeSearchResult?.resultId,
    normalizedSearchQuery,
    searchBlockMatches,
  ]);

  const moveToSearchResult = (direction: 'previous' | 'next') => {
    if (effectiveTotalCount === 0) {
      return;
    }
    setActiveSearchResultIndex((previousIndex) => {
      if (direction === 'previous') {
        return previousIndex <= 0 ? effectiveTotalCount - 1 : previousIndex - 1;
      }
      return previousIndex >= effectiveTotalCount - 1 ? 0 : previousIndex + 1;
    });
  };

  return (
    <SessionSearchProvider value={searchContextValue}>
      <div className="relative w-full bg-muted/10 p-4" style={{ height }}>
        <SessionSearchBar
          query={query}
          currentIndex={effectiveActiveIndex}
          totalCount={effectiveTotalCount}
          inputRef={inputRef}
          onQueryChange={(value) => {
            setQuery(value);
            setActiveSearchResultIndex(0);
          }}
          onPrevious={() => moveToSearchResult('previous')}
          onNext={() => moveToSearchResult('next')}
          onClose={() => setQuery('')}
          t={t}
        />
        {showChatBackdrop && (
          <div className="h-full rounded-2xl border border-border/60 bg-background pt-16 shadow-xs">
            <SessionChatStreamView
              sessionId={sessionId}
              items={buildItems(searchMessages)}
              renderMessageRow={renderMessageRow}
            />
          </div>
        )}
      </div>
    </SessionSearchProvider>
  );
}

export const Default: Story = {
  args: {
    sessionId,
    items: buildItems(searchMessages),
    renderMessageRow,
  },
  render: () => <SearchStoryPreview />,
};

// The transcript's tool call mentions "rg" in its title, path, terminal output and
// diff; none of those are indexed, so every hit here comes from message prose.
export const ProseOnlyMatches: Story = {
  args: {
    sessionId,
    items: buildItems(searchMessages),
    renderMessageRow,
  },
  render: () => <SearchStoryPreview initialQuery="rg" initialActiveIndex={1} />,
};

export const Empty: Story = {
  args: {
    sessionId,
    items: buildItems(searchMessages),
    renderMessageRow,
  },
  render: () => <SearchStoryPreview initialQuery="" initialActiveIndex={0} />,
};

export const NoResults: Story = {
  args: {
    sessionId,
    items: buildItems(searchMessages),
    renderMessageRow,
  },
  render: () => (
    <SearchStoryPreview initialQuery="quantumfizzbuzz" initialActiveIndex={0} forceTotalCount={0} />
  ),
};

export const ManyResults: Story = {
  args: {
    sessionId,
    items: buildItems(searchMessages),
    renderMessageRow,
  },
  render: () => <SearchStoryPreview initialQuery="search" initialActiveIndex={42} />,
};

export const States: Story = {
  args: {
    sessionId,
    items: buildItems(searchMessages),
    renderMessageRow,
  },
  render: () => (
    <div className="flex w-full flex-col gap-4 bg-muted/20 p-6">
      <StateRow label="Empty (focused)">
        <SearchStoryPreview initialQuery="" showChatBackdrop={false} height={68} />
      </StateRow>
      <StateRow label="With active result">
        <SearchStoryPreview
          initialQuery="search"
          initialActiveIndex={1}
          showChatBackdrop={false}
          height={68}
        />
      </StateRow>
      <StateRow label="Many matches (42 / 128)">
        <SearchStoryPreview
          initialQuery="search"
          initialActiveIndex={42}
          showChatBackdrop={false}
          height={68}
        />
      </StateRow>
      <StateRow label="No results">
        <SearchStoryPreview
          initialQuery="quantumfizzbuzz"
          initialActiveIndex={0}
          forceTotalCount={0}
          showChatBackdrop={false}
          height={68}
        />
      </StateRow>
    </div>
  ),
};

function StateRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/40 p-3">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="relative w-full">{children}</div>
    </div>
  );
}

import type { Meta, StoryObj } from '@storybook/react';
import type { SessionHistory, SessionHistoryParsed, SessionId } from '@lody/shared';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Tooltip } from '@lody/ui/tooltip';
import {
  MessageRowView,
  SessionChatStreamView,
  type ChatStreamItem,
  type SessionChatStreamViewProps,
} from '@/components/ai-gui/view';
import { SessionSearchBar } from '@/components/sessions/session-chat-interface';
import {
  SessionSearchProvider,
  type SessionSearchBlockMatch,
} from '@/components/sessions/session-search-context';
import {
  buildSessionSearchResults,
  extractSessionSearchBlocks,
  normalizeSessionSearchQuery,
} from '@/lib/session-chat-search';
import { themeColors } from '../style/theme-colors.stylex';
import { themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  canvas: {
    display: 'flex',
    height: '100vh',
    minWidth: 0,
    minHeight: 0,
    flexDirection: 'column',
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  controls: { display: 'flex', flexShrink: 0, gap: themeSpace[2], padding: themeSpace[3] },
  surface: { position: 'relative', minWidth: 0, minHeight: 0, flex: '1 1 0%' },
});

const sessionId = 'session-search-migration' as SessionId;
const messages: SessionHistoryParsed[] = [
  {
    id: 'migration-user',
    role: 'user',
    timestamp: '2026-10-22T09:00:00.000Z',
    read: true,
    items: [
      { type: 'text', text: 'Find search in this session. Search is literal: QA_RESUMED_OK.' },
    ],
  },
  {
    id: 'migration-assistant',
    role: 'assistant',
    timestamp: '2026-10-22T09:00:01.000Z',
    finished: true,
    items: [
      { type: 'thought', text: 'Search thinking: preserve QA_RESUMED_OK while finding results.' },
      {
        type: 'text',
        text: [
          'Search results appear in **search** prose and `search` inline code.',
          '',
          'QA_RESUMED_OK in plain text, **QA_RESUMED_OK** in bold, and `QA_RESUMED_OK` in code.',
          '',
          '[QA_RESUMED_OK](https://example.com/migration-fixture)',
          '',
          '```text',
          'QA_RESUMED_OK',
          '```',
        ].join('\n'),
      },
    ],
  },
];

const manyMessages: SessionHistoryParsed[] = [
  {
    id: 'migration-many-user',
    role: 'user',
    timestamp: '2026-10-22T09:00:00.000Z',
    read: true,
    items: [{ type: 'text', text: 'needle '.repeat(128) }],
  },
];

const renderMessageRow: SessionChatStreamViewProps['renderMessageRow'] = ({
  message,
  sessionId: messageSessionId,
}) => <MessageRowView message={message} sessionId={messageSessionId} />;

/** Controlled data only: search chrome, user marks, Markdown marks and thoughts are real consumers. */
function SearchFixture({
  source = messages,
  initialOpen = false,
  initialQuery = '',
  initialIndex = 0,
}: {
  source?: SessionHistoryParsed[];
  initialOpen?: boolean;
  initialQuery?: string;
  initialIndex?: number;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = useState(initialOpen);
  const [query, setQuery] = useState(initialQuery);
  const [index, setIndex] = useState(initialIndex);
  const blocks = useMemo(() => extractSessionSearchBlocks(source as SessionHistory[]), [source]);
  const normalized = normalizeSessionSearchQuery(query);
  const results = useMemo(
    () => buildSessionSearchResults(blocks, normalized),
    [blocks, normalized]
  );
  const activeIndex = results.length ? Math.min(index, results.length - 1) : 0;
  const active = results[activeIndex];
  const value = useMemo(() => {
    const blockMatches = new Map<string, SessionSearchBlockMatch>();
    if (isOpen && normalized) {
      for (const result of results) {
        const match = blockMatches.get(result.blockId) ?? {
          blockId: result.blockId,
          resultIds: [],
          activeResultId: null,
          activeOccurrenceIndex: null,
        };
        match.resultIds.push(result.resultId);
        if (result.resultId === active?.resultId) {
          match.activeResultId = result.resultId;
          match.activeOccurrenceIndex = result.localIndex;
        }
        blockMatches.set(result.blockId, match);
      }
    }
    const matchedIds = [...blockMatches.keys()];
    const activeBlockId = isOpen && normalized ? (active?.blockId ?? null) : null;
    return {
      isOpen: isOpen && normalized.length > 0,
      query: isOpen ? normalized : '',
      activeBlockId,
      activeResultId: isOpen ? (active?.resultId ?? null) : null,
      blockMatches,
      hasMatchedPrefix: (prefix: string) =>
        matchedIds.some((id) => id === prefix || id.startsWith(`${prefix}:`)),
      hasActivePrefix: (prefix: string) =>
        activeBlockId !== null &&
        (activeBlockId === prefix || activeBlockId.startsWith(`${prefix}:`)),
    };
  }, [active, isOpen, normalized, results]);
  const items = useMemo<ChatStreamItem[]>(
    () => source.map((message, turnIndex) => ({ type: 'message', sessionId, message, turnIndex })),
    [source]
  );

  useLayoutEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  const move = (direction: number) => {
    if (results.length)
      setIndex((current) => (current + direction + results.length) % results.length);
  };

  return (
    <Tooltip.Provider>
      <SessionSearchProvider value={value}>
        <div {...stylex.props(styles.canvas)}>
          <div {...stylex.props(styles.controls)}>
            <Button
              onClick={() => {
                setIsOpen(true);
                inputRef.current?.focus();
              }}
            >
              Open search
            </Button>
          </div>
          <div {...stylex.props(styles.surface)}>
            {isOpen ? (
              <SessionSearchBar
                query={query}
                currentIndex={activeIndex}
                totalCount={results.length}
                inputRef={inputRef}
                onQueryChange={(next) => {
                  setQuery(next);
                  setIndex(0);
                }}
                onPrevious={() => move(-1)}
                onNext={() => move(1)}
                onClose={() => setIsOpen(false)}
                t={t}
              />
            ) : null}
            <SessionChatStreamView
              sessionId={sessionId}
              items={items}
              renderMessageRow={renderMessageRow}
            />
          </div>
        </div>
      </SessionSearchProvider>
    </Tooltip.Provider>
  );
}

const meta = {
  title: 'Sessions/SearchMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Interactive: Story = { render: () => <SearchFixture /> };
export const ManyMatches: Story = {
  render: () => (
    <SearchFixture source={manyMessages} initialOpen initialQuery="needle" initialIndex={127} />
  ),
};
export const LiteralMarkdown: Story = {
  render: () => <SearchFixture initialOpen initialQuery="QA_RESUMED_OK" initialIndex={1} />,
};

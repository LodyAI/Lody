import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { MarkdownRenderer } from '../components/ai-gui/markdown-renderer';
import { MarkdownTable } from '../components/ai-gui/markdown-table';
import {
  SearchHighlightedText,
  SessionSearchProvider,
  SEARCH_HIGHLIGHT_MARK_CLASS_NAME,
  SEARCH_HIGHLIGHT_ACTIVE_MARK_CLASS_NAME,
  SEARCH_HIGHLIGHT_CONTAINER_ACTIVE_CLASS_NAME,
} from '../components/sessions/session-search-context';
import { cn } from '../lib/utils';

const meta = {
  title: 'Components/OwnedSearchTableMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const variables = {
  '--color-amber-200': 'oklch(88% 0.13 80)',
  '--color-amber-300': 'oklch(78% 0.15 70)',
  '--color-amber-400': 'oklch(68% 0.17 60)',
  '--foreground': '275 50% 35%',
  '--primary': '300 60% 45%',
  '--tw-ring-offset-width': '2px',
  '--tw-ring-offset-color': 'rgb(200, 220, 240)',
} as CSSProperties;
const tableText = [
  '| Key | 中文标题 | Summary | Result | Owner | Region | Reference | Detail |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  '| alpha | 中文搜索 | A long synthetic explanation with enough prose to wrap naturally. | Passed | Synthetic team | North | abcdef0123456789abcdef0123456789abcdef | Another deliberately long explanation for horizontal overflow. |',
  '| beta | 迁移验收 | A pipe \\| remains inside its cell. | Pending | Local only | South | xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx | **Bold** and `inline code` remain rendered cells. |',
].join('\n');

function Fixture({
  mode = 'active',
  scope,
}: {
  mode?: 'table' | 'active' | 'inactive' | 'absent' | 'cjk';
  scope?: 'root' | 'subtree';
}) {
  const [store] = useState(createStore);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [payload, setPayload] = useState('');
  const [activeBlock, setActiveBlock] = useState<string | null>(
    mode === 'inactive' ? null : 'plain'
  );
  const [open, setOpen] = useState(mode !== 'absent');
  const pending = useRef<{ resolve: () => void; reject: () => void } | null>(null);
  const query = mode === 'cjk' ? '搜索' : 'needle';
  const plain =
    mode === 'cjk'
      ? '中文搜索：搜索高亮、再次搜索与边界。'
      : 'Needle plain needle and another needle.';
  const markdown =
    mode === 'cjk'
      ? '中文搜索，**搜索高亮**与再次搜索。'
      : 'Needle prose, **needle bold**, and another needle.';
  const value = useMemo(() => {
    const blockMatches = new Map(
      ['plain', 'markdown'].map((blockId) => [
        blockId,
        {
          blockId,
          resultIds: [0, 1, 2].map((index) => `${blockId}-${index}`),
          activeResultId: activeBlock === blockId ? `${blockId}-1` : null,
          activeOccurrenceIndex: activeBlock === blockId ? 1 : null,
        },
      ])
    );
    return {
      isOpen: open,
      query,
      activeBlockId: activeBlock,
      activeResultId: activeBlock ? `${activeBlock}-1` : null,
      blockMatches,
      hasMatchedPrefix: (prefix: string) => open && blockMatches.has(prefix),
      hasActivePrefix: (prefix: string) => open && activeBlock === prefix,
    };
  }, [activeBlock, open, query]);
  useLayoutEffect(() => {
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const previousCopy = document.execCommand;
    const record = async (items: ClipboardItem[]) => {
      const item = items[0];
      const text = item ? await (await item.getType('text/plain')).text() : '';
      const html = item ? await (await item.getType('text/html')).text() : '';
      setPayload(JSON.stringify({ text, hasTable: html.includes('<table'), types: item?.types }));
      setStatus('Copy pending');
      return new Promise<void>((resolve, reject) => {
        pending.current = {
          resolve: () => {
            setStatus('Copy resolved');
            resolve();
          },
          reject: () => {
            setStatus('Copy rejected');
            reject(new Error('Synthetic clipboard rejection'));
          },
        };
      });
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: record,
        writeText: async () => {
          throw new Error('Synthetic fallback unavailable');
        },
      },
    });
    document.execCommand = () => false;
    const settle = (event: Event) => {
      if ((event as CustomEvent<string>).detail === 'reject') pending.current?.reject();
      else pending.current?.resolve();
      pending.current = null;
    };
    window.addEventListener('search-table-copy-settle', settle);
    const root = document.documentElement;
    const previousVars = Object.keys(variables).map((name) => [
      name,
      root.style.getPropertyValue(name),
    ]);
    if (scope === 'root')
      for (const [name, variableValue] of Object.entries(variables))
        root.style.setProperty(name, variableValue);
    setReady(true);
    return () => {
      if (previous) Object.defineProperty(navigator, 'clipboard', previous);
      else Reflect.deleteProperty(navigator, 'clipboard');
      document.execCommand = previousCopy;
      window.removeEventListener('search-table-copy-settle', settle);
      if (scope === 'root')
        for (const [name, previousValue] of previousVars) {
          if (previousValue) root.style.setProperty(name, previousValue);
          else root.style.removeProperty(name);
        }
    };
  }, [scope]);
  if (!ready) return null;
  return (
    <Provider store={store}>
      <SessionSearchProvider value={value}>
        <main
          data-search-table-fixture={mode}
          style={{
            padding: 20,
            height: '100vh',
            overflow: 'auto',
            boxSizing: 'border-box',
            ...(scope === 'subtree' ? variables : {}),
          }}
        >
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button
              type="button"
              data-search-toggle-active
              onClick={() =>
                setActiveBlock((current) =>
                  current === 'plain' ? 'markdown' : current === 'markdown' ? null : 'plain'
                )
              }
            >
              Toggle active
            </button>
            <button
              type="button"
              data-search-toggle-open
              onClick={() => setOpen((current) => !current)}
            >
              Toggle search
            </button>
          </div>
          <output data-search-table-result style={{ display: 'block', marginBottom: 12 }}>
            {status}
          </output>
          <output data-search-table-payload hidden>
            {payload}
          </output>
          {mode === 'table' ? (
            <>
              <section data-search-table-long>
                <MarkdownRenderer text={tableText} />
              </section>
              <section data-search-table-direct style={{ marginTop: 20 }}>
                <MarkdownTable className="text-base leading-8" style={{ letterSpacing: '0.4px' }}>
                  <thead>
                    <tr>
                      <th>Caller</th>
                      <th>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Inline and class precedence</td>
                      <td>中文 | text</td>
                    </tr>
                  </tbody>
                </MarkdownTable>
              </section>
            </>
          ) : (
            <>
              <section data-search-plain style={{ padding: 12, marginBottom: 16 }}>
                <SearchHighlightedText blockId="plain" text={plain} className="leading-8" />
              </section>
              <section data-search-markdown style={{ padding: 12, marginBottom: 16 }}>
                <MarkdownRenderer text={markdown} searchBlockId="markdown" />
              </section>
              <section data-search-public style={{ display: 'grid', gap: 16, padding: 12 }}>
                <div>
                  <mark data-public-mark tabIndex={0} className={SEARCH_HIGHLIGHT_MARK_CLASS_NAME}>
                    Public inactive
                  </mark>
                </div>
                <div>
                  <mark
                    data-public-active
                    tabIndex={0}
                    className={cn(
                      SEARCH_HIGHLIGHT_MARK_CLASS_NAME,
                      SEARCH_HIGHLIGHT_ACTIVE_MARK_CLASS_NAME
                    )}
                  >
                    Public active
                  </mark>
                </div>
                <div
                  data-public-container
                  tabIndex={0}
                  className={SEARCH_HIGHLIGHT_CONTAINER_ACTIVE_CLASS_NAME}
                  style={{ padding: 8 }}
                >
                  Public active container
                </div>
                <div>
                  <mark
                    data-public-caller
                    tabIndex={0}
                    className={cn(
                      SEARCH_HIGHLIGHT_MARK_CLASS_NAME,
                      SEARCH_HIGHLIGHT_ACTIVE_MARK_CLASS_NAME,
                      'bg-pink-200 dark:bg-pink-900 ring-2 ring-pink-500 shadow-none rounded-none'
                    )}
                    style={{ outlineOffset: 6 }}
                  >
                    Caller palette and ring
                  </mark>
                </div>
              </section>
            </>
          )}
        </main>
      </SessionSearchProvider>
    </Provider>
  );
}

export const Table: Story = { render: () => <Fixture mode="table" /> };
export const Active: Story = { render: () => <Fixture /> };
export const Inactive: Story = { render: () => <Fixture mode="inactive" /> };
export const Absent: Story = { render: () => <Fixture mode="absent" /> };
export const Cjk: Story = { render: () => <Fixture mode="cjk" /> };
export const RootPalette: Story = { render: () => <Fixture scope="root" /> };
export const SubtreePalette: Story = { render: () => <Fixture scope="subtree" /> };

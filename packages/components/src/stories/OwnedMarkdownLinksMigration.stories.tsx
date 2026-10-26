import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Provider, createStore } from 'jotai';
import { Copy, ExternalLink, FolderOpen } from 'lucide-react';
import {
  AgentFileLinkContextMenuItemsContext,
  MarkdownRenderer,
} from '../components/ai-gui/markdown-renderer';
import { PrLinkProvider } from '../components/ai-gui/pr-link-context';
import { SessionReadonlyContext } from '../components/ai-gui/session-readonly-context';
import type { MarkdownAgentFileLinkMenuItem } from '../hooks/use-session-file-actions';

const meta = {
  title: 'Components/OwnedMarkdownLinksMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const PR = 'https://github.com/synthetic-owner/synthetic-repo/pull/42';
const LONG_PATH =
  'packages/synthetic-workspace/components/international-team/very-long-development-module/fixtures/长路径说明-and-rendering-contract.test.tsx#L24';
const CONTENT = `A prose file [guide](./guide.md) and a long reference [${LONG_PATH}](${LONG_PATH}) stay beside normal prose.

| [Header file](./header.tsx#L3) | Reference and note |
| --- | --- |
| [Body file](./body.tsx#L8) | A short value |
| [${LONG_PATH}](${LONG_PATH}) | CJK 中文 and a deliberately long file label that must wrap without forcing a page-width overflow. |
| [Image path](./images/synthetic.png#L2) | A line-anchored file reference, not an image load |

References [#42](${PR}) and [#7](https://github.com/synthetic-owner/synthetic-repo/issues/7) keep their reference chips. [Descriptive PR link](${PR}) and [ordinary article](https://example.invalid/synthetic-article) stay ordinary links.

[Blocked script](javascript:alert%281%29) and [blocked resource](data:text/html,synthetic) must never become executable navigation.`;

function Fixture({ mode }: { mode: 'copy' | 'open' | 'menu' | 'scoped' | 'readonly' }) {
  const [store] = useState(createStore);
  const [ready, setReady] = useState(false);
  const [result, setResult] = useState('Ready');
  const pending = useRef<{ resolve: () => void; reject: () => void } | null>(null);
  useLayoutEffect(() => {
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const previousCopy = document.execCommand;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          setResult(`Copy pending: ${text}`);
          return new Promise<void>((resolve, reject) => {
            pending.current = {
              resolve: () => {
                setResult(`Copied: ${text}`);
                resolve();
              },
              reject: () => {
                setResult(`Copy rejected: ${text}`);
                reject(new Error('Synthetic clipboard rejection'));
              },
            };
          });
        },
      },
    });
    document.execCommand = () => false;
    const settle = (event: Event) => {
      if ((event as CustomEvent<string>).detail === 'reject') pending.current?.reject();
      else pending.current?.resolve();
      pending.current = null;
    };
    window.addEventListener('markdown-links-clipboard-settle', settle);
    setReady(true);
    return () => {
      if (previous) Object.defineProperty(navigator, 'clipboard', previous);
      else Reflect.deleteProperty(navigator, 'clipboard');
      document.execCommand = previousCopy;
      window.removeEventListener('markdown-links-clipboard-settle', settle);
    };
  }, []);
  const menu = (href: string): readonly MarkdownAgentFileLinkMenuItem[] => [
    {
      kind: 'action',
      id: 'copy-synthetic',
      label: 'Record path',
      icon: Copy,
      run: () => setResult(`Menu path: ${href}`),
    },
    {
      kind: 'submenu',
      id: 'open-synthetic',
      label: 'Open using',
      icon: ExternalLink,
      items: [
        {
          kind: 'action',
          id: 'editor',
          label: 'Synthetic editor',
          icon: FolderOpen,
          run: () => setResult(`Editor: ${href}`),
        },
      ],
    },
  ];
  const scoped = mode === 'scoped';
  const variables = scoped
    ? ({
        '--spacing': '0.3125rem',
        '--radius-md': '17px',
        '--default-transition-duration': '200ms',
        '--default-transition-timing-function': 'linear',
      } as CSSProperties)
    : undefined;
  if (!ready) return null;
  return (
    <Provider store={store}>
      <PrLinkProvider prUrl={PR} onOpenPrTab={() => setResult('PR opened: synthetic #42')}>
        <SessionReadonlyContext.Provider
          value={mode === 'readonly' ? { renderImage: () => null, renderFiles: () => null } : null}
        >
          <AgentFileLinkContextMenuItemsContext.Provider value={mode === 'menu' ? menu : undefined}>
            <main
              data-markdown-links-fixture={mode}
              style={{ padding: 16, maxWidth: 960, marginInline: 'auto', ...variables }}
            >
              <output data-markdown-links-result="" style={{ display: 'block', marginBottom: 16 }}>
                {result}
              </output>
              <MarkdownRenderer
                text={CONTENT}
                className={
                  scoped
                    ? '[&_button]:inline-flex [&_button_span]:whitespace-nowrap [&_.markdown-reference-chip]:rounded-none'
                    : undefined
                }
                onAgentFileLinkClick={
                  mode === 'open' || mode === 'menu'
                    ? (href) => setResult(`Opened: ${href}`)
                    : undefined
                }
              />
            </main>
          </AgentFileLinkContextMenuItemsContext.Provider>
        </SessionReadonlyContext.Provider>
      </PrLinkProvider>
    </Provider>
  );
}

export const CopyLinks: Story = { render: () => <Fixture mode="copy" /> };
export const OpenLinks: Story = { render: () => <Fixture mode="open" /> };
export const ContextMenus: Story = { render: () => <Fixture mode="menu" /> };
export const ScopedCallerOverrides: Story = { render: () => <Fixture mode="scoped" /> };
export const ReadOnly: Story = { render: () => <Fixture mode="readonly" /> };

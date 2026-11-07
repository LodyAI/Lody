import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Tooltip } from '@lody/ui/tooltip';
import { SessionSearchBar } from '../components/sessions/session-chat-interface';

const styles = stylex.create({
  canvas: {
    position: 'relative',
    width: '100%',
    minHeight: '240px',
    backgroundColor: 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
  },
  receipt: { position: 'absolute', top: '180px', left: '16px', fontSize: '12px' },
});

function Fixture({ initialQuery = '', results = 5 }: { initialQuery?: string; results?: number }) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(true);
  const [event, setEvent] = useState('ready');
  const count = query.length ? results : 0;
  useLayoutEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  const move = (step: number) => {
    if (!count) return;
    setIndex((value) => (value + step + count) % count);
    setEvent(step > 0 ? 'next' : 'previous');
  };
  return (
    <Tooltip.Provider>
      <section
        {...stylex.props(styles.canvas)}
        data-search-token-fixture
        data-search-open={String(open)}
        data-search-query={query}
        data-search-count={count}
        data-search-index={index}
      >
        {open ? (
          <SessionSearchBar
            query={query}
            currentIndex={index}
            totalCount={count}
            inputRef={inputRef}
            onQueryChange={(value) => {
              setQuery(value);
              setIndex(0);
              setEvent('changed');
            }}
            onPrevious={() => move(-1)}
            onNext={() => move(1)}
            onClose={() => {
              setOpen(false);
              setEvent('closed');
            }}
            t={t}
          />
        ) : (
          <Button
            onClick={() => {
              setOpen(true);
              setEvent('reopened');
            }}
          >
            Reopen search
          </Button>
        )}
        <output {...stylex.props(styles.receipt)} data-search-token-event>
          {event}
        </output>
      </section>
    </Tooltip.Provider>
  );
}

const meta = {
  title: 'Migration/OwnedSessionSearchTokens',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = { render: () => <Fixture /> };
export const Results: Story = { render: () => <Fixture initialQuery="needle" /> };
export const NoResults: Story = { render: () => <Fixture initialQuery="missing" results={0} /> };
export const ManyResults: Story = { render: () => <Fixture initialQuery="needle" results={128} /> };
export const Interactive: Story = { render: () => <Fixture results={5} /> };

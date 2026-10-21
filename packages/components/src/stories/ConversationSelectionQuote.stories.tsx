import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { ForceMobileLayoutProvider } from '@/hooks/use-mobile';
import { formatSelectionQuote } from '@/lib/conversation-selection-quote';
import {
  SelectionQuoteBar,
  useSelectionQuote,
} from '@/components/ai-gui/selection-quote';
import {
  SessionConversationPage,
  SessionConversationPageBody,
} from '@/components/sessions/session-conversation-page';

const prose = [
  'The filter creates a new array on each render, so the list sees new props every keystroke.',
  'Memoize the filtered result and keep the row props stable; profile again afterwards.',
].join('\n\n');

function QuoteHarness() {
  const { quoteText, clear } = useSelectionQuote({
    scopeId: 'selection-quote-story',
    enabled: true,
    history: { indexOf: (id) => (id === 'turn-1' ? 0 : -1) },
  });
  const [staged, setStaged] = useState('');
  return (
    <SessionConversationPage
      className="h-dvh"
      bodySlot={
        <SessionConversationPageBody
          streamSlot={
            <div className="p-6">
              {/* `data-native-selection-allow` is what makes a message body
                  selectable at all; production rows set it on their prose. */}
              <div data-conversation-row-key="turn-1" data-conversation-turn-id="turn-1">
                <p className="whitespace-pre-wrap" data-native-selection-allow>
                  {prose}
                </p>
              </div>
              <pre className="mt-6 whitespace-pre-wrap rounded-md border border-dashed p-3 text-xs">
                {staged || 'Select prose above to quote it'}
              </pre>
            </div>
          }
          composerSlot={
            <SelectionQuoteBar
              quote={quoteText}
              onQuote={(text) => {
                setStaged(formatSelectionQuote({ text }));
                clear();
              }}
              onDismiss={clear}
            />
          }
        />
      }
    />
  );
}

const meta = {
  title: 'Sessions/ConversationSelectionQuote',
  component: QuoteHarness,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof QuoteHarness>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};

/** Handset width: the quote takes its own line above default-size actions. */
export const MobileQuote: Story = {
  parameters: { viewport: { defaultViewport: 'mobile1' } },
  render: () => (
    <ForceMobileLayoutProvider force>
      <QuoteHarness />
    </ForceMobileLayoutProvider>
  ),
};

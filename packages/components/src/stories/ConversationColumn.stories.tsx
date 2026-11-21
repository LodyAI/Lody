import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Provider, createStore } from 'jotai';
import * as stylex from '@stylexjs/stylex';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { conversationWideModeAtom } from '@/atoms/settings';

const styles = stylex.create({
  frame: { width: '100%', minHeight: 300 },
  callerInset: { paddingInline: 'calc(var(--spacing) * 3)' },
});
function ColumnStory({ inset = false }: { inset?: boolean }) {
  const [store] = useState(() => {
    const value = createStore();
    value.set(conversationWideModeAtom, false);
    return value;
  });
  return (
    <Provider store={store}>
      <main {...stylex.props(styles.frame)}>
        <button onClick={() => store.set(conversationWideModeAtom, (v) => !v)}>
          Toggle full width
        </button>
        <ConversationColumn xstyle={inset ? styles.callerInset : undefined}>
          <label>
            Draft
            <input defaultValue="A preserved draft" />
          </label>
        </ConversationColumn>
      </main>
    </Provider>
  );
}
const meta = {
  title: 'Shared/ConversationColumn',
  component: ColumnStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ColumnStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const CallerInset: Story = { args: { inset: true } };

import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';

import { UserMessageEditor } from '@/components/ai-gui/user-message-editor';
import { MessageRowView } from '@/components/ai-gui/view';
import type { ConversationFontSize } from '@/atoms/settings';

const SHORT_TEXT = '你好';
const LONG_TEXT = Array.from(
  { length: 12 },
  (_, index) =>
    `Line ${index + 1}: rewrite the failing migration so the backfill is idempotent and re-runnable.`
).join('\n');

function EditorHarness({
  initialValue,
  isSaving = false,
  conversationFontSize = 14,
}: {
  initialValue: string;
  isSaving?: boolean;
  conversationFontSize?: ConversationFontSize;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    // The editor lives right-aligned in the user column, so preview it that way.
    <div className="flex w-[42rem] max-w-full justify-end">
      <UserMessageEditor
        value={value}
        onChange={setValue}
        onCancel={() => setValue(initialValue)}
        onSave={() => undefined}
        isSaving={isSaving}
        conversationFontSize={conversationFontSize}
      />
    </div>
  );
}

const meta: Meta<typeof UserMessageEditor> = {
  title: 'AI GUI/UserMessageEditor',
  component: UserMessageEditor,
  parameters: { layout: 'centered' },
};

export default meta;

type Story = StoryObj<typeof UserMessageEditor>;

export const ShortMessage: Story = {
  render: () => <EditorHarness initialValue={SHORT_TEXT} />,
};

export const FromMessageEdit: Story = {
  render: () => (
    <MessageRowView
      sessionId={'session-editor-story' as SessionId}
      message={
        {
          id: 'editable-user-message',
          role: 'user',
          timestamp: '2026-09-12T10:00:00.000Z',
          status: 'seen',
          read: true,
          items: [{ type: 'text', text: 'Clarify this instruction' }],
        } satisfies SessionHistoryParsed
      }
      onEdit={async () => true}
    />
  ),
};

export const Empty: Story = {
  render: () => <EditorHarness initialValue="" />,
};

export const LongMessage: Story = {
  render: () => <EditorHarness initialValue={LONG_TEXT} />,
};

export const Saving: Story = {
  render: () => <EditorHarness initialValue={SHORT_TEXT} isSaving />,
};

export const LargeFontSize: Story = {
  render: () => <EditorHarness initialValue={SHORT_TEXT} conversationFontSize={24} />,
};

export const NarrowColumn: Story = {
  render: () => (
    <div className="w-[22rem]">
      <EditorHarness initialValue={SHORT_TEXT} />
    </div>
  ),
};

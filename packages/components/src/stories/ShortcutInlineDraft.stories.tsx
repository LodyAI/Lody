import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { createShortcutInvocation, type PromptShortcut } from '@lody/shared/prompt-shortcuts';
import { Mention, MentionInput } from '@/ui/mention';
import { getComposerMentionChip } from '@/components/mentions/mention-chips';

/**
 * Several invocations inside one ordinary draft.
 *
 * A chip is an atomic reference with its own frozen snapshot, and the text
 * around it stays ordinary Prompt — that is the whole point of inserting one
 * rather than expanding it.
 */
const body: PromptShortcut = {
  v: 1,
  id: 'review',
  workspaceId: 'ws',
  ownerUserId: 'user',
  visibility: 'private',
  name: 'Review',
  slug: 'review',
  prompt: 'Review the change\n  Keep the team checklist in mind',
  mentions: [],
  scope: {},
  revision: 'r1',
  createdAt: 1,
  updatedAt: 1,
};

function Harness() {
  const [text, setText] = useState('Before /review and /review after');
  const [mentions] = useState(() => [
    {
      start: 7,
      end: 14,
      value: 'one',
      kind: 'prompt_shortcut',
      data: createShortcutInvocation('one', body),
    },
    {
      start: 19,
      end: 26,
      value: 'two',
      kind: 'prompt_shortcut',
      data: createShortcutInvocation('two', body),
    },
  ]);
  return (
    <div className="w-[min(560px,95vw)] rounded-lg border bg-background p-4 [--mention-chip-surface:hsl(var(--background))]">
      <Mention
        editHistory
        inputValue={text}
        onInputValueChange={setText}
        defaultMentions={mentions}
        getMentionChip={getComposerMentionChip}
      >
        <MentionInput
          value={text}
          aria-label="Prompt"
          className="w-full resize-none bg-transparent p-2"
        />
      </Mention>
    </div>
  );
}

const meta = {
  title: 'Chat/Shortcut Inline Draft',
  component: Harness,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;
export const MultipleChips: Story = {};

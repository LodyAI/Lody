import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import {
  getComposerMentionChip,
  wrapPastedTextChipLabel,
} from '@/components/mentions/mention-chips';
import { cn } from '@/lib/utils';
import { Mention, MentionInput, MentionLabel } from '@/ui/mention';
import type { Mention as MentionRange } from '@/ui/mention/index';

/**
 * Prototype for icon chips in the plain-textarea composer.
 *
 * The mention menu is deliberately out of the picture: these stories drive the
 * `Mention` primitive directly so the only variable is how a committed range is
 * painted. Type into any box — the ranges track edits, and the caret, the
 * selection, and the wrap points all come from the native textarea underneath,
 * so a chip that measured wrong would visibly drift from the text it decorates.
 */

const PASTED_LABEL = wrapPastedTextChipLabel('[Pasted 4,182 chars]');

type Fixture = {
  text: string;
  mentions: MentionRange[];
};

/** Builds ranges by searching for each token, so the offsets cannot go stale. */
const fixture = (text: string, tokens: Array<[string, string]>): Fixture => ({
  text,
  mentions: tokens.map(([token, kind]) => {
    const start = text.indexOf(token);
    if (start < 0) throw new Error(`token not in fixture text: ${token}`);
    return { value: token, start, end: start + token.length, kind };
  }),
});

const MIXED = fixture(
  `Compare @src/ui/mention/mention-highlighter.tsx against #482, run $review-diff, then summarise ${PASTED_LABEL} for @crdt-metadata-cleanup.`,
  [
    ['@src/ui/mention/mention-highlighter.tsx', 'file'],
    ['#482', 'issue'],
    ['$review-diff', 'skill'],
    [PASTED_LABEL, 'pasted_text'],
    ['@crdt-metadata-cleanup', 'session'],
  ]
);

const SHORT = fixture('Read @src/lib/utils.ts and @packages/shared/ before you edit #17.', [
  ['@src/lib/utils.ts', 'file'],
  ['@packages/shared/', 'dir'],
  ['#17', 'issue'],
]);

const WRAPPING = fixture(
  'Trace the regression through @apps/cli/src/session/turn-evidence-store.ts and @packages/components/src/components/sessions/use-session-all-changes-diff-data.ts — both were touched by #904.',
  [
    ['@apps/cli/src/session/turn-evidence-store.ts', 'file'],
    ['@packages/components/src/components/sessions/use-session-all-changes-diff-data.ts', 'file'],
    ['#904', 'issue'],
  ]
);

// A slash command owns the whole prompt, so its chip always starts at offset 0
// — the one position with no preceding space for the icon to hang into.
const SLASH = fixture('/plan', [['/plan', 'command']]);

function ComposerBox({
  label,
  fixture: initial,
  chips,
}: {
  label: string;
  fixture: Fixture;
  chips: boolean;
}) {
  const [value, setValue] = useState(initial.text);
  const [mentions, setMentions] = useState(initial.mentions);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="font-medium text-muted-foreground text-xs">{label}</div>
      <Mention
        inputValue={value}
        onInputValueChange={setValue}
        mentions={mentions}
        onMentionsChange={setMentions}
        getMentionChip={chips ? getComposerMentionChip : undefined}
        triggers={[]}
        className={cn(
          'w-full rounded-xl border border-foreground/[0.10] bg-background px-3 py-2.5',
          'dark:border-input-border/70 dark:bg-input/90'
        )}
      >
        <MentionLabel className="sr-only">Prototype composer</MentionLabel>
        <MentionInput
          value={value}
          rows={3}
          className="resize-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
        />
      </Mention>
    </div>
  );
}

function Board({ chips }: { chips: boolean }) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 bg-background p-8">
      <ComposerBox label="Mixed kinds" fixture={MIXED} chips={chips} />
      <ComposerBox label="Short paths" fixture={SHORT} chips={chips} />
      <ComposerBox label="Long paths (a chip has to wrap)" fixture={WRAPPING} chips={chips} />
      <ComposerBox label="Slash command at offset 0" fixture={SLASH} chips={chips} />
    </div>
  );
}

const meta = {
  title: 'Chat/MentionChips',
  component: Board,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Board>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Today's rendering: a tinted background behind the raw text. */
export const PlainHighlight: Story = {
  args: { chips: false },
};

/** The prototype: icon over the trigger character, chip-coloured label. */
export const IconChips: Story = {
  args: { chips: true },
};

export const IconChipsDark: Story = {
  args: { chips: true },
  globals: { theme: 'dark' },
};

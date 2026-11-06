import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties } from 'react';

import {
  getComposerMentionChip,
  wrapPastedTextChipLabel,
} from '@/components/mentions/mention-chips';
import { Mention, MentionInput, MentionLabel } from '@/ui/mention';
import { Root as MentionRoot, type Mention as MentionRange } from '@/ui/mention/index';
const chipStory = stylex.create({
  surface: {
    width: '100%',
    borderRadius: 'var(--radius-xl)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: {
      default: 'color-mix(in oklab,hsl(var(--foreground) / 1) 10%,transparent)',
      ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))':
        'color-mix(in oklab,hsl(var(--input-border) / 1) 70%,transparent)',
    },
    backgroundColor: {
      default: 'hsl(var(--background) / 1)',
      ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))':
        'color-mix(in oklab,hsl(var(--input) / 1) 90%,transparent)',
    },
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 2.5)',
    '--mention-chip-surface': {
      default: 'hsl(var(--background))',
      ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))':
        'color-mix(in srgb,hsl(var(--input)) 90%,hsl(var(--background)))',
    },
  },
  input: {
    resize: 'none',
    borderWidth: 0,
    backgroundColor: 'transparent',
    padding: 0,
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    boxShadow: {
      default: '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000',
      ':focus-visible':
        '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 0px var(--lody-input-focus-ring, transparent), 0 0 #0000',
    },
  },
});
const storyLayoutStyles = stylex.create({
  caption: {
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-medium)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
});

const storyLayout = stylex.create({
  hiddenLabel: {
    position: 'absolute',
    width: 1,
    height: 1,
    margin: -1,
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
  stack: {
    display: 'flex',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 1.5)',
  },
  stack2: {
    'margin-inline': 'auto',
    display: 'flex',
    'max-width': '42rem',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 6)',
    'background-color': 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 8)',
  },
});

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
  unwrapped = false,
}: {
  label: string;
  fixture: Fixture;
  chips: boolean;
  unwrapped?: boolean;
}) {
  const [value, setValue] = useState(initial.text);
  const [mentions, setMentions] = useState(initial.mentions);
  const Root = unwrapped ? MentionRoot : Mention;

  return (
    <div {...stylex.props(storyLayout.stack)} data-mention-fixture-box={label}>
      <div {...stylex.props(storyLayoutStyles.caption)}>{label}</div>
      <Root
        inputValue={value}
        onInputValueChange={setValue}
        mentions={mentions}
        onMentionsChange={setMentions}
        getMentionChip={chips ? getComposerMentionChip : undefined}
        triggers={[]}
        // The real composer's surface, verbatim, including the
        // `--mention-chip-surface` it sets. A decoration hides the textarea's
        // glyphs by painting that colour, so a story on a *different* surface
        // would hide the one bug this is most likely to have: the cover showing
        // up as a rectangle.
        className={stylex.props(chipStory.surface).className}
      >
        <MentionLabel xstyle={storyLayout.hiddenLabel}>Prototype composer</MentionLabel>
        <MentionInput value={value} rows={3} xstyle={chipStory.input} />
      </Root>
    </div>
  );
}

function Board({ chips, unwrapped = false }: { chips: boolean; unwrapped?: boolean }) {
  return (
    <div {...stylex.props(storyLayout.stack2)}>
      <ComposerBox label="Mixed kinds" fixture={MIXED} chips={chips} unwrapped={unwrapped} />
      <ComposerBox label="Short paths" fixture={SHORT} chips={chips} unwrapped={unwrapped} />
      <ComposerBox
        label="Long paths (a chip has to wrap)"
        fixture={WRAPPING}
        chips={chips}
        unwrapped={unwrapped}
      />
      <ComposerBox
        label="Slash command at offset 0"
        fixture={SLASH}
        chips={chips}
        unwrapped={unwrapped}
      />
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

export const ScopeTokens: Story = {
  args: { chips: false, unwrapped: true },
  render: (args) => (
    <div
      data-mention-token-scope=""
      style={
        {
          '--foreground': '153 43% 26%',
          '--primary': '277 64% 41%',
          '--radius-md': '13px',
          '--radius-sm': '7px',
        } as CSSProperties
      }
    >
      <Board {...args} />
    </div>
  ),
};

const nativeControlStyles = stylex.create({
  utility: {
    display: 'block',
    width: 'calc(var(--spacing) * 56)',
    resize: 'vertical',
    color: 'hsl(var(--destructive) / 1)',
  },
  opaque: { display: 'grid', width: 173, resize: 'vertical', color: 'rgb(17, 57, 89)', zIndex: 47 },
});

function NativeFieldControl({ caller = 'default' }: { caller?: 'default' | 'utility' | 'opaque' }) {
  const [value, setValue] = useState(SHORT.text);
  const [mentions, setMentions] = useState(SHORT.mentions);
  const [disabled, setDisabled] = useState(false);
  const [readonly, setReadonly] = useState(false);
  const inputStyles =
    caller === 'utility'
      ? nativeControlStyles.utility
      : caller === 'opaque'
        ? nativeControlStyles.opaque
        : undefined;
  return (
    <div data-native-mention-control={caller} style={{ padding: 20, maxWidth: 760 }}>
      <button
        type="button"
        data-native-disabled
        onClick={() => setDisabled((previous) => !previous)}
      >
        Toggle disabled
      </button>
      <button
        type="button"
        data-native-readonly
        onClick={() => setReadonly((previous) => !previous)}
      >
        Toggle readonly
      </button>
      <Mention
        inputValue={value}
        onInputValueChange={setValue}
        mentions={mentions}
        onMentionsChange={setMentions}
        getMentionChip={getComposerMentionChip}
        triggers={[]}
        disabled={disabled}
        readonly={readonly}
      >
        <MentionLabel>Visible native composer</MentionLabel>
        <MentionInput
          value={value}
          rows={3}
          xstyle={inputStyles}
          aria-label="Native mention control"
        />
      </Mention>
      <output data-native-mention-state>
        {JSON.stringify({ value, mentions, disabled, readonly })}
      </output>
    </div>
  );
}

export const NativeFields: Pick<Story, 'render'> = { render: () => <NativeFieldControl /> };
export const NativeFieldUtilityCaller: Pick<Story, 'render'> = {
  render: () => <NativeFieldControl caller="utility" />,
};
export const NativeFieldOpaqueCaller: Pick<Story, 'render'> = {
  render: () => <NativeFieldControl caller="opaque" />,
};

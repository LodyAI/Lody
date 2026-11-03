import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import type { CommentReferencePayload } from '@lody/shared';
import {
  CommentReferenceChip,
  type CommentReferenceChipItem,
} from '@/components/chat/comment-reference-chip';
import { CommentReferenceCard } from '@/components/ai-gui/comment-reference-card';
const storyLayout = stylex.create({
  row: {
    display: 'flex',
    'max-width': '28rem',
    'flex-wrap': 'wrap',
    gap: 'calc(var(--spacing) * 2)',
  },
  section: {
    'max-width': '28rem',
  },
  frame: {
    'margin-inline': 'auto',
    width: '100%',
    'max-width': '32rem',
    padding: 'calc(var(--spacing) * 4)',
  },
  row2: {
    display: 'flex',
    'flex-wrap': 'wrap',
    gap: 'calc(var(--spacing) * 2)',
    'padding-bottom': 'calc(var(--spacing) * 2)',
  },
  row3: {
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'flex-end',
    'padding-top': 'calc(var(--spacing) * 1)',
  },
  stack: {
    display: 'flex',
    'flex-direction': 'column',
    'align-items': 'flex-end',
    gap: 'calc(var(--spacing) * 2)',
  },
  stack2: {
    display: 'flex',
    width: '100%',
    'max-width': '85%',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 2)',
  },
  row4: {
    display: 'flex',
    width: '100%',
    'justify-content': 'flex-end',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-top': 'calc(var(--spacing) * 1)',
  },
  row5: {
    display: 'flex',
    width: '100%',
    'justify-content': 'flex-end',
    'padding-inline': 'calc(var(--spacing) * 2)',
  },
  stack3: {
    'margin-inline': 'auto',
    display: 'flex',
    width: '100%',
    'max-width': '32rem',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 6)',
    padding: 'calc(var(--spacing) * 4)',
  },
  section2: {
    'min-width': 'calc(var(--spacing) * 0)',
    flex: '1',
  },
});

// -- Shared mock data --

const mockReference: CommentReferencePayload = {
  source: 'lody',
  path: 'src/utils/helper.ts',
  lineNumber: 42,
  side: 'additions',
  commentBody: 'This function should handle edge cases better, especially when the input is null.',
  authorName: 'alice',
  authorImage: 'https://github.com/alice.png',
  replies: [
    { authorName: 'bob', body: 'Agreed, let me add null checks.' },
    { authorName: 'charlie', body: 'Also consider empty arrays.' },
  ],
  threadId: 'thread-1',
};

const mockGitHubReference: CommentReferencePayload = {
  source: 'github',
  path: 'packages/components/src/components/App.tsx',
  lineNumber: 15,
  side: 'deletions',
  commentBody: 'Consider using useMemo here to avoid unnecessary re-renders on each state change.',
  authorName: 'reviewer42',
  authorImage: 'https://github.com/reviewer42.png',
  githubThreadId: 12345,
};

const mockShortReference: CommentReferencePayload = {
  source: 'lody',
  path: 'index.ts',
  lineNumber: 1,
  side: 'additions',
  commentBody: 'LGTM',
  authorName: 'dave',
};

// -- CommentReferenceChip stories --

const chipMeta: Meta<typeof CommentReferenceChip> = {
  title: 'DiffViewer/CommentReferenceChip',
  component: CommentReferenceChip,
  parameters: { layout: 'padded' },
};

export default chipMeta;

type ChipStory = StoryObj<typeof CommentReferenceChip>;

export const Default: ChipStory = {
  args: {
    item: { localId: '1', reference: mockReference },
    onRemove: undefined,
  },
};

export const WithRemove: ChipStory = {
  args: {
    item: { localId: '1', reference: mockReference },
    onRemove: (id: string) => alert(`Remove: ${id}`),
  },
};

export const GitHubSource: ChipStory = {
  args: {
    item: { localId: '2', reference: mockGitHubReference },
    onRemove: (id: string) => alert(`Remove: ${id}`),
  },
};

export const ShortComment: ChipStory = {
  args: {
    item: { localId: '3', reference: mockShortReference },
    onRemove: (id: string) => alert(`Remove: ${id}`),
  },
};

export const MultipleChips: StoryObj = {
  render: () => {
    const items: CommentReferenceChipItem[] = [
      { localId: '1', reference: mockReference },
      { localId: '2', reference: mockGitHubReference },
      { localId: '3', reference: mockShortReference },
    ];

    return (
      <div {...stylex.props(storyLayout.row)}>
        {items.map((item) => (
          <CommentReferenceChip
            key={item.localId}
            item={item}
            onRemove={(id) => alert(`Remove: ${id}`)}
          />
        ))}
      </div>
    );
  },
};

// -- CommentReferenceCard stories --

export const CardDefault: StoryObj<typeof CommentReferenceCard> = {
  name: 'Card / Default',
  render: () => (
    <div {...stylex.props(storyLayout.section)}>
      <CommentReferenceCard reference={mockReference} onClick={() => alert('Navigate to diff')} />
    </div>
  ),
};

export const CardGitHub: StoryObj<typeof CommentReferenceCard> = {
  name: 'Card / GitHub',
  render: () => (
    <div {...stylex.props(storyLayout.section)}>
      <CommentReferenceCard
        reference={mockGitHubReference}
        onClick={() => alert('Navigate to diff')}
      />
    </div>
  ),
};

export const CardNoClick: StoryObj<typeof CommentReferenceCard> = {
  name: 'Card / No Click',
  render: () => (
    <div {...stylex.props(storyLayout.section)}>
      <CommentReferenceCard reference={mockShortReference} />
    </div>
  ),
};

// -- Composer with comment references --

export const ComposerWithReferences: StoryObj = {
  name: 'Composer / With Comment References',
  render: function ComposerWithRefs() {
    const [items, setItems] = useState<CommentReferenceChipItem[]>([
      { localId: '1', reference: mockReference },
      { localId: '2', reference: mockGitHubReference },
    ]);
    const [text, setText] = useState('Can you fix these issues? The null check is critical.');

    return (
      <div {...stylex.props(storyLayout.frame)}>
        <div className="rounded-xl border border-input-border/70 bg-input/90 px-4 py-3">
          {items.length > 0 && (
            <div {...stylex.props(storyLayout.row2)}>
              {items.map((item) => (
                <CommentReferenceChip
                  key={item.localId}
                  item={item}
                  onRemove={(id) => setItems((prev) => prev.filter((i) => i.localId !== id))}
                />
              ))}
            </div>
          )}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            className="w-full resize-none border-none bg-transparent text-sm leading-6 text-foreground placeholder:text-muted-foreground focus:outline-hidden"
            placeholder="Type your message..."
          />
          <div {...stylex.props(storyLayout.row3)}>
            <button
              type="button"
              className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    );
  },
};

// -- User chat bubble with comment references --

export const UserBubbleWithReferences: StoryObj = {
  name: 'User Bubble / With Comment References',
  render: () => (
    <div className="mx-auto w-full max-w-lg space-y-6 p-4">
      {/* User message with one comment ref + text */}
      <div {...stylex.props(storyLayout.stack)}>
        <div {...stylex.props(storyLayout.stack2)}>
          <div {...stylex.props(storyLayout.row4)}>
            <CommentReferenceCard
              reference={mockReference}
              onClick={() => alert('Navigate to diff')}
            />
          </div>
          <div className="ml-auto rounded-2xl bg-muted px-4 py-2.5 text-sm leading-relaxed">
            Can you fix this edge case? The function should handle null inputs gracefully.
          </div>
        </div>
      </div>

      {/* User message with multiple comment refs + text */}
      <div {...stylex.props(storyLayout.stack)}>
        <div {...stylex.props(storyLayout.stack2)}>
          <div {...stylex.props(storyLayout.row4)}>
            <CommentReferenceCard reference={mockReference} onClick={() => alert('Navigate')} />
          </div>
          <div {...stylex.props(storyLayout.row5)}>
            <CommentReferenceCard
              reference={mockGitHubReference}
              onClick={() => alert('Navigate')}
            />
          </div>
          <div className="ml-auto rounded-2xl bg-muted px-4 py-2.5 text-sm leading-relaxed">
            Please address both of these review comments. The useMemo one is especially important
            for performance.
          </div>
        </div>
      </div>

      {/* User message with only comment ref, no text */}
      <div {...stylex.props(storyLayout.stack)}>
        <div {...stylex.props(storyLayout.stack2)}>
          <div {...stylex.props(storyLayout.row4)}>
            <CommentReferenceCard
              reference={mockShortReference}
              onClick={() => alert('Navigate')}
            />
          </div>
        </div>
      </div>
    </div>
  ),
};

// -- Interactive: full flow from thread to composer --

export const InteractiveFlow: StoryObj = {
  name: 'Interactive / Full Flow',
  render: function FullFlow() {
    const [composerItems, setComposerItems] = useState<CommentReferenceChipItem[]>([]);
    const [sentMessages, setSentMessages] = useState<
      { text: string; refs: CommentReferencePayload[] }[]
    >([]);
    const [text, setText] = useState('');

    let nextId = composerItems.length + 1;

    const handleSendToChat = (ref: CommentReferencePayload) => {
      setComposerItems((prev) => [...prev, { localId: String(nextId++), reference: ref }]);
    };

    const handleSend = () => {
      if (composerItems.length === 0 && !text.trim()) return;
      setSentMessages((prev) => [
        ...prev,
        { text: text.trim(), refs: composerItems.map((i) => i.reference) },
      ]);
      setComposerItems([]);
      setText('');
    };

    return (
      <div {...stylex.props(storyLayout.stack3)}>
        {/* Instructions */}
        <div className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:bg-blue-950 dark:text-blue-300">
          Click the paper plane icon on a thread below to add it to the composer. Then click Send.
        </div>

        {/* Mock threads with send-to-chat buttons */}
        <div className="space-y-3">
          <h3 className="text-xs font-medium text-muted-foreground">Comment Threads</h3>
          {[mockReference, mockGitHubReference].map((ref, i) => (
            <div key={i} className="flex items-start gap-2 rounded-lg border p-3">
              <div {...stylex.props(storyLayout.section2)}>
                <div className="text-xs font-medium">{ref.authorName}</div>
                <div className="text-xs text-muted-foreground">
                  {ref.path}:{ref.lineNumber}
                </div>
                <div className="mt-1 text-xs">{ref.commentBody}</div>
              </div>
              <button
                type="button"
                className="shrink-0 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                onClick={() => handleSendToChat(ref)}
              >
                Send to chat
              </button>
            </div>
          ))}
        </div>

        {/* Sent messages */}
        {sentMessages.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-xs font-medium text-muted-foreground">
              Sent Messages (User Bubbles)
            </h3>
            {sentMessages.map((msg, i) => (
              <div key={i} {...stylex.props(storyLayout.stack)}>
                <div {...stylex.props(storyLayout.stack2)}>
                  {msg.refs.map((ref, j) => (
                    <div key={j} {...stylex.props(storyLayout.row5)}>
                      <CommentReferenceCard reference={ref} onClick={() => alert('Navigate')} />
                    </div>
                  ))}
                  {msg.text && (
                    <div className="ml-auto rounded-2xl bg-muted px-4 py-2 text-sm">{msg.text}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Composer */}
        <div>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">Composer</h3>
          <div className="rounded-xl border border-input-border/70 bg-input/90 px-4 py-3">
            {composerItems.length > 0 && (
              <div {...stylex.props(storyLayout.row2)}>
                {composerItems.map((item) => (
                  <CommentReferenceChip
                    key={item.localId}
                    item={item}
                    onRemove={(id) =>
                      setComposerItems((prev) => prev.filter((i) => i.localId !== id))
                    }
                  />
                ))}
              </div>
            )}
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={2}
              className="w-full resize-none border-none bg-transparent text-sm leading-6 text-foreground placeholder:text-muted-foreground focus:outline-hidden"
              placeholder="Type your message..."
            />
            <div {...stylex.props(storyLayout.row3)}>
              <button
                type="button"
                className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground"
                onClick={handleSend}
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  },
};

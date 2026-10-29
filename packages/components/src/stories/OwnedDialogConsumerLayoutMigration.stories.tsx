import type { Meta, StoryObj } from '@storybook/react';
import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Provider } from 'jotai';
import type { SessionId } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { ThemeRoot } from '@lody/ui/theme';
import { ModalContainerProvider } from '@lody/ui/popup-container';
import { ChatComposer } from '../components/chat/chat-composer';
import { SessionFileQuickOpen } from '../components/sessions/session-file-quick-open';
import { OperationReplyCard } from '../components/ai-gui/operation-reply-card';
import { wrapPastedTextChipLabel } from '../components/mentions/mention-chips';
import type { PastedTextDraft } from '../lib/pasted-text-draft';
import { SettingsStoryProviders } from './settings-story-shell';

const meta = {
  title: 'Migration/OwnedDialogConsumerLayout',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const longText = Array.from(
  { length: 80 },
  (_, index) =>
    `Synthetic line ${index + 1}: preserved pasted content 中文 and a long readable sentence.`
).join('\n');
const label = wrapPastedTextChipLabel('[Pasted 80 lines]');
const initialPrompt = `Read ${label}.`;
const initialDraft: PastedTextDraft[] = [
  {
    id: 'dialog-layout-paste',
    text: longText,
    displayText: label,
    start: 5,
    end: 5 + label.length,
  },
];

function Composer() {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [drafts, setDrafts] = useState(initialDraft);
  return (
    <section data-dialog-consumer="composer">
      <ChatComposer
        variant="landing"
        promptId="dialog-layout-prompt"
        promptRef={promptRef}
        promptValue={prompt}
        onPromptChange={setPrompt}
        pastedTextDrafts={drafts}
        onPastedTextDraftsChange={setDrafts}
        primaryAction={<Button>Send</Button>}
      />
      <output data-dialog-layout-draft-length>{drafts[0]?.text.length ?? 0}</output>
    </section>
  );
}

function QuickOpen() {
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState('none');
  return (
    <section data-dialog-consumer="quick-open">
      <Button onClick={() => setOpen(true)}>Open file picker</Button>
      <output aria-label="Opened file">{selected}</output>
      <SessionFileQuickOpen
        open={open}
        onOpenChange={setOpen}
        fallbackPaths={Array.from(
          { length: 80 },
          (_, index) =>
            `src/synthetic/deeply-nested-directory/file-${String(index).padStart(3, '0')}.tsx`
        )}
        onOpenFile={setSelected}
      />
    </section>
  );
}

function Operation() {
  return (
    <section data-dialog-consumer="operation">
      <OperationReplyCard
        sessionId={'dialog-layout-session' as SessionId}
        fallbackTitle="Synthetic operation reply with a long descriptive title 中文边界"
        status="succeeded"
        reply={longText}
      />
    </section>
  );
}

function Fixture({ scoped = false, children }: { scoped?: boolean; children: ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const frame = (
    <div
      ref={setHost}
      data-dialog-layout-fixture={scoped ? 'hosted-dark' : 'default'}
      className={scoped ? 'dark-scope' : undefined}
      style={
        {
          position: 'relative',
          minHeight: '100vh',
          padding: 20,
          ...(scoped ? { '--spacing': '6px' } : {}),
        } as CSSProperties
      }
    >
      {scoped ? (
        <ModalContainerProvider container={host}>{host ? children : null}</ModalContainerProvider>
      ) : (
        children
      )}
    </div>
  );
  return (
    <Provider>
      <SettingsStoryProviders>
        {scoped ? <ThemeRoot mode="dark">{frame}</ThemeRoot> : frame}
      </SettingsStoryProviders>
    </Provider>
  );
}

export const ComposerDefault: Story = {
  render: () => (
    <Fixture>
      <Composer />
    </Fixture>
  ),
};
export const ComposerHosted: Story = {
  render: () => (
    <Fixture scoped>
      <Composer />
    </Fixture>
  ),
};
export const QuickOpenDefault: Story = {
  render: () => (
    <Fixture>
      <QuickOpen />
    </Fixture>
  ),
};
export const QuickOpenHosted: Story = {
  render: () => (
    <Fixture scoped>
      <QuickOpen />
    </Fixture>
  ),
};
export const OperationDefault: Story = {
  render: () => (
    <Fixture>
      <Operation />
    </Fixture>
  ),
};
export const OperationHosted: Story = {
  render: () => (
    <Fixture scoped>
      <Operation />
    </Fixture>
  ),
};

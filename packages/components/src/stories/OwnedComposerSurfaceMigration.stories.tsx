import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { ChatComposer } from '@/components/chat/chat-composer';
import { wrapPastedTextChipLabel } from '@/components/mentions/mention-chips';
import type { PastedTextDraft } from '@/lib/pasted-text-draft';
import { SettingsStoryProviders } from './settings-story-shell';
import { themeColors } from '../style/theme-colors.stylex';

const styles = stylex.create({
  frame: {
    padding: 16,
    maxWidth: 720,
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  controls: { display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 },
  output: { display: 'block', marginTop: 8, fontSize: 12 },
  scopes: { display: 'flex', flexDirection: 'column', gap: 8 },
});

const fileToken = '@src/app.ts';
const pastedLabel = wrapPastedTextChipLabel('[Pasted 4 chars]');
const initialPrompt = `Read ${fileToken} and ${pastedLabel}.`;
const initialPastedText: PastedTextDraft[] = [
  {
    id: 'surface-paste',
    text: 'data',
    displayText: pastedLabel,
    start: initialPrompt.indexOf(pastedLabel),
    end: initialPrompt.indexOf(pastedLabel) + pastedLabel.length,
  },
];
const persistedMentions = [
  {
    value: fileToken,
    kind: 'file',
    start: initialPrompt.indexOf(fileToken),
    end: initialPrompt.indexOf(fileToken) + fileToken.length,
  },
];

function SurfaceFixture({
  variant = 'landing',
  disabled = false,
  localPalette = false,
  chips = true,
  id = 'surface',
}: {
  variant?: 'landing' | 'session' | 'dialog';
  disabled?: boolean;
  localPalette?: boolean;
  chips?: boolean;
  id?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [pasted, setPasted] = useState(initialPastedText);
  const [lastEvent, setLastEvent] = useState('none');
  const [received, setReceived] = useState<string[]>([]);
  const [lastPrevented, setLastPrevented] = useState(false);

  const getBox = () =>
    root.current?.querySelector<HTMLElement>('[data-lody-composer-box]') ??
    promptRef.current?.parentElement;

  useLayoutEffect(() => {
    if (!localPalette) return;
    const box = getBox();
    if (!box) return;
    box.style.setProperty('--input', '260 50% 40%');
    box.style.setProperty('--input-border', '24 80% 56%');
    box.style.setProperty('--composer', '160 40% 82%');
    box.style.setProperty('--background', '210 50% 88%');
    box.dataset.surfaceLocalPalette = '';
  }, [localPalette]);

  function dispatchFileEvent(type: 'dragenter' | 'dragleave' | 'drop') {
    const box = getBox();
    if (!box) return;
    const transfer = new DataTransfer();
    transfer.items.add(new File(['synthetic image payload'], 'surface.png', { type: 'image/png' }));
    const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
    box.dispatchEvent(event);
    setLastEvent(type);
    setLastPrevented(event.defaultPrevented);
  }

  return (
    <div
      ref={root}
      data-composer-surface-fixture={id}
      data-surface-event={lastEvent}
      data-surface-prevented={lastPrevented}
      data-surface-received={received.join(',')}
      {...stylex.props(styles.frame)}
    >
      <div {...stylex.props(styles.controls)}>
        <Button size="small" onClick={() => dispatchFileEvent('dragenter')} data-surface-enter>
          Enter file
        </Button>
        <Button size="small" onClick={() => dispatchFileEvent('dragleave')} data-surface-leave>
          Leave file
        </Button>
        <Button size="small" onClick={() => dispatchFileEvent('drop')} data-surface-drop>
          Drop file
        </Button>
      </div>
      <ChatComposer
        variant={variant}
        promptId={`${id}-prompt`}
        promptRef={promptRef}
        promptValue={prompt}
        onPromptChange={setPrompt}
        promptRows={2}
        promptDisabled={disabled}
        pastedTextDrafts={chips ? pasted : undefined}
        onPastedTextDraftsChange={setPasted}
        persistedMentions={chips ? persistedMentions : undefined}
        onImageDrop={(files) =>
          setReceived((current) => [...current, ...files.map((file) => file.name)])
        }
        primaryAction={<Button disabled={disabled}>Send</Button>}
      />
      <output {...stylex.props(styles.output)}>
        Event {lastEvent}; accepted {String(lastPrevented)}; files {received.join(',') || 'none'}
      </output>
    </div>
  );
}

function ScopedSurfaceFixture({ variant }: { variant: 'landing' | 'session' | 'dialog' }) {
  return (
    <div
      data-composer-surface-palette
      {...stylex.props(styles.scopes)}
      style={
        {
          '--input': '300 55% 38%',
          '--input-border': '190 70% 40%',
          '--composer': '48 65% 80%',
          '--background': '210 40% 90%',
        } as CSSProperties
      }
    >
      <div className="dark-scope" data-surface-scope="dark">
        <SurfaceFixture variant={variant} localPalette id="surface-dark" />
      </div>
      <div className="dark-scope">
        <div className="light-scope" data-surface-scope="light">
          <SurfaceFixture variant={variant} localPalette id="surface-light" />
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedComposerSurface',
  component: SurfaceFixture,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <SettingsStoryProviders>
        <Story />
      </SettingsStoryProviders>
    ),
  ],
} satisfies Meta<typeof SurfaceFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Landing: Story = {};
export const Session: Story = { args: { variant: 'session' } };
export const Dialog: Story = { args: { variant: 'dialog' } };
export const DialogWithoutChips: Story = { args: { variant: 'dialog', chips: false } };
export const Disabled: Story = { args: { disabled: true } };
export const ScopedLanding: Story = { render: () => <ScopedSurfaceFixture variant="landing" /> };
export const ScopedSession: Story = { render: () => <ScopedSurfaceFixture variant="session" /> };
export const ScopedDialog: Story = { render: () => <ScopedSurfaceFixture variant="dialog" /> };

import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { card } from '@lody/ui/card/card.tokens.stylex';
import { field } from '@lody/ui/field/field.tokens.stylex';
import { colors, media } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { ContextSwitch, type SessionContextType } from '@/components/chat/context-switch';
import { useTheme } from '@/theme-provider';
import { ChatComposer } from '@/components/chat/chat-composer';
import {
  getComposerMentionChip,
  wrapPastedTextChipLabel,
} from '@/components/mentions/mention-chips';
import { CombinedMentionTextarea } from '@/components/mentions/combined-mention-textarea';
import { SettingsStoryProviders } from './settings-story-shell';

const styles = stylex.create({
  board: {
    maxWidth: 720,
    padding: space[4],
    display: 'flex',
    flexDirection: 'column',
    gap: space[4],
    color: colors.label,
    backgroundColor: colors.background,
  },
  references: {
    display: 'flex',
    gap: space[2],
    flexWrap: 'wrap',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
  swatch: { padding: space[2], minHeight: 32 },
  card: { backgroundColor: card.background, boxShadow: card.shadow, borderRadius: card.radius },
  field: {
    backgroundColor: field.background,
    boxShadow: field.well,
    color: field.value,
    borderRadius: field.radiusMedium,
    fontSize: field.text,
    lineHeight: text.subheadlineLeading,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
  },
  media: { backgroundColor: media.scrim, color: media.label },
  title: { fontSize: text.titleSize, lineHeight: text.titleLeading },
  hint: { color: field.placeholder },
  focus: { boxShadow: `0 0 0 2px ${colors.accent}, ${card.shadow}` },
  secondary: { color: colors.secondaryLabel },
  warning: { color: colors.warning },
});

function Board({ disabled = false, fallback = false }: { disabled?: boolean; fallback?: boolean }) {
  const [value, setValue] = useState('');
  const chipLabel = wrapPastedTextChipLabel('[Pasted 12 chars]');
  const [fieldValue, setFieldValue] = useState(chipLabel);
  return (
    <div
      {...stylex.props(styles.board)}
      data-design-system-proof
      data-fallback={fallback}
      data-disabled={disabled}
    >
      <ChatComposer
        variant="landing"
        title="Compose a message"
        promptId="ds-composer"
        promptValue={value}
        onPromptChange={setValue}
        promptDisabled={disabled}
        promptPlaceholder="Write a message"
        imageItems={[
          {
            id: 'ds-media',
            name: 'media-reference.svg',
            previewUrl:
              'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="80" height="80"%3E%3Cpath fill="white" d="M0 0h80v80H0z"/%3E%3C/svg%3E',
            status: 'uploading',
            progress: 45,
          },
        ]}
        statusTone="warning"
        statusMessage="Choose a project before sending."
        secondaryAction={{ label: 'Cancel draft', disabled, onClick: () => setValue('') }}
        primaryAction={<Button disabled={disabled}>Send message</Button>}
      />
      <div data-ds-field>
        <CombinedMentionTextarea
          id="ds-standalone-field"
          value={fieldValue}
          onValueChange={setFieldValue}
          label="Standalone message"
          placeholder="Add context"
          disabled={disabled}
          externalMentions={
            fallback
              ? undefined
              : [
                  {
                    kind: 'pasted_text',
                    value: 'ds-pasted-reference',
                    start: 0,
                    end: chipLabel.length,
                  },
                ]
          }
          getMentionChip={fallback ? undefined : getComposerMentionChip}
          onExternalMentionsChange={fallback ? undefined : () => {}}
        />
      </div>
      <div {...stylex.props(styles.references)} aria-label="Design system references">
        <div {...stylex.props(styles.swatch, styles.card)} data-ds-token="card">
          Card material
        </div>
        <div {...stylex.props(styles.swatch, styles.media)} data-ds-token="media">
          Image caption
        </div>
        <div {...stylex.props(styles.swatch, styles.field)} data-ds-token="field">
          Field well
        </div>
        <span {...stylex.props(styles.swatch, styles.title)} data-ds-token="title">
          Page title
        </span>
        <span {...stylex.props(styles.swatch, styles.hint)} data-ds-token="placeholder">
          Placeholder
        </span>
        <div {...stylex.props(styles.swatch, styles.focus)} data-ds-token="focus">
          Composer focus
        </div>
        <span {...stylex.props(styles.swatch, styles.secondary)} data-ds-token="secondary">
          Supporting text
        </span>
        <span {...stylex.props(styles.swatch, styles.warning)} data-ds-token="warning">
          Warning mark
        </span>
      </div>
      <output data-ds-draft>{value || 'Empty draft'}</output>
    </div>
  );
}

const meta = {
  title: 'Design System/Product Convergence',
  component: Board,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <SettingsStoryProviders>
        <Story />
      </SettingsStoryProviders>
    ),
  ],
} satisfies Meta<typeof Board>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Mention: Story = {};
export const Disabled: Story = { args: { disabled: true } };
export const PlainFallback: Story = { args: { fallback: true } };

function ContextChoices() {
  const [value, setValue] = useState<SessionContextType>('chat');
  const [connected, setConnected] = useState(false);
  const { resolvedTheme } = useTheme();
  return (
    <div {...stylex.props(styles.board)} data-ds-context>
      <ContextSwitch
        value={value}
        onChange={setValue}
        tone={resolvedTheme === 'dark' ? 'dark' : 'light'}
        localDisabled={{ label: 'Desktop only' }}
        githubDisabled={
          connected ? undefined : { label: 'Connect GitHub', onClick: () => setConnected(true) }
        }
      />
      <output aria-label="Context choice">{value}</output>
      <output aria-label="GitHub connection">{connected ? 'Connected' : 'Not connected'}</output>
    </div>
  );
}
export const ContextActions: Story = { render: () => <ContextChoices /> };

import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { EmojiField } from '@/components/settings/emoji-field';
import { getBundledEmojibaseUrl } from '@/lib/emojibase-assets';
import {
  EmojiPicker,
  EmojiPickerContent,
  EmojiPickerFooter,
  EmojiPickerSearch,
} from '@/ui/emoji-picker';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { themeColors } from '../style/theme-colors.stylex';
import { themeFontSize, themeLineHeight, themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  canvas: {
    minHeight: '100dvh',
    padding: themeSpace[4],
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  surface: {
    width: 'fit-content',
    maxWidth: '100%',
    backgroundColor: colors.raisedBackground,
  },
  callerSurface: { width: 320 },
  result: {
    display: 'block',
    marginTop: themeSpace[3],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
  },
  field: {
    width: 40,
    height: 40,
    backgroundColor: colors.raisedBackground,
    borderRadius: 8,
  },
});

function Fixture({
  disabled = false,
  caller = false,
  locale = 'en',
  columns = 10,
}: {
  disabled?: boolean;
  caller?: boolean;
  locale?: 'en' | 'zh';
  columns?: number;
}) {
  const [selected, setSelected] = useState('none');
  return (
    <div {...stylex.props(styles.canvas)}>
      <div {...stylex.props(styles.surface, caller && styles.callerSurface)}>
        <EmojiPicker
          emojibaseUrl={getBundledEmojibaseUrl()}
          locale={locale}
          columns={columns}
          className={caller ? 'h-[360px] w-full rounded-none' : 'h-[320px]'}
          style={caller ? { border: '2px solid hsl(var(--border))' } : undefined}
          onEmojiSelect={({ emoji }) => setSelected(emoji)}
        >
          <EmojiPickerSearch
            aria-label="Search emoji"
            placeholder={locale === 'zh' ? '搜索表情…' : 'Search emoji…'}
            disabled={disabled}
            className={caller ? 'h-12 px-2' : undefined}
            style={caller ? { fontSize: 15 } : undefined}
          />
          <EmojiPickerContent
            className={caller ? 'min-h-0' : undefined}
            style={caller ? { scrollbarGutter: 'stable' } : undefined}
          />
          <EmojiPickerFooter
            className={caller ? 'gap-3 p-3' : undefined}
            style={caller ? { borderTopWidth: 2 } : undefined}
          />
        </EmojiPicker>
      </div>
      <output data-emoji-result {...stylex.props(styles.result)}>
        Selected: {selected}
      </output>
    </div>
  );
}

function ConsumerFixture() {
  const [value, setValue] = useState('');
  return (
    <div {...stylex.props(styles.canvas)}>
      <div {...stylex.props(styles.field)}>
        <EmojiField value={value} defaultEmoji="✨" onChange={setValue} />
      </div>
      <output data-emoji-result {...stylex.props(styles.result)}>
        Selected: {value || 'none'}
      </output>
    </div>
  );
}

const meta = {
  title: 'Ui/EmojiPickerMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Inline: Story = { render: () => <Fixture /> };
export const DisabledSearch: Story = { render: () => <Fixture disabled /> };
export const CallerOverrides: Story = { render: () => <Fixture caller /> };
export const Chinese: Story = { render: () => <Fixture locale="zh" /> };
export const CompactColumns: Story = { render: () => <Fixture columns={6} /> };
export const ConsumerPopover: Story = { render: () => <ConsumerFixture /> };

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CONVERSATION_FONT_SIZES,
  normalizeConversationFontSize,
  type ConversationFontSize,
} from '@/atoms/settings';

export function ConversationFontSizeSlider({
  value,
  onChange,
}: {
  value: ConversationFontSize;
  onChange: (value: ConversationFontSize) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const size = normalizeConversationFontSize(value);
  const index = CONVERSATION_FONT_SIZES.findIndex((candidate) => candidate === size);
  const progress = (index / (CONVERSATION_FONT_SIZES.length - 1)) * 100;

  return (
    <div className="flex w-full min-w-0 items-center gap-3" data-vaul-no-drag>
      <span className="text-xs text-muted-foreground" aria-hidden="true">
        A
      </span>
      <div className="relative flex min-w-0 flex-1 items-center">
        <div className="pointer-events-none absolute inset-x-0 h-1 overflow-hidden rounded-full bg-border">
          <div className="h-full bg-primary" style={{ width: `${progress}%` }} />
        </div>
        <input
          id={id}
          type="range"
          min={0}
          max={CONVERSATION_FONT_SIZES.length - 1}
          step={1}
          value={index}
          aria-valuetext={`${size} px`}
          aria-label={t('settings.conversationFontSize.label', 'Conversation font size')}
          className="relative m-0 h-11 w-full cursor-pointer touch-pan-y appearance-none rounded-md bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-border [&::-webkit-slider-thumb]:bg-background [&::-webkit-slider-thumb]:shadow-sm dark:[&::-webkit-slider-thumb]:bg-foreground [&::-moz-range-thumb]:h-6 [&::-moz-range-thumb]:w-6 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-border [&::-moz-range-thumb]:bg-background [&::-moz-range-thumb]:shadow-sm dark:[&::-moz-range-thumb]:bg-foreground"
          onChange={(event) => onChange(CONVERSATION_FONT_SIZES[event.currentTarget.valueAsNumber])}
        />
      </div>
      <span className="text-xl text-muted-foreground" aria-hidden="true">
        A
      </span>
      <output
        htmlFor={id}
        className="w-11 shrink-0 text-right text-sm tabular-nums text-foreground"
      >
        {size} px
      </output>
    </div>
  );
}

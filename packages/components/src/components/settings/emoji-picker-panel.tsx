import { useTranslation } from 'react-i18next';
import { normalizeAgentRoleEmoji } from '@lody/shared';
import { getBundledEmojibaseUrl, resolveEmojibaseLocale } from '@/lib/emojibase-assets';
import {
  EmojiPicker,
  EmojiPickerContent,
  EmojiPickerFooter,
  EmojiPickerSearch,
} from '@/ui/emoji-picker';

/**
 * The picker body, in its own module so `frimousse` is not in the entry chunk.
 *
 * Settings is reachable from the app shell, so a static import would parse the
 * whole picker library at renderer startup for a popover that only opens inside
 * the Agent Role editor. The popover unmounts its content when closed, so the
 * lazy boundary is exactly the mount.
 */
export default function AgentRoleEmojiPicker({ onSelect }: { onSelect: (emoji: string) => void }) {
  const { i18n } = useTranslation();
  return (
    <EmojiPicker
      className="h-[320px]"
      // The dataset ships with the app, so the picker works offline.
      emojibaseUrl={getBundledEmojibaseUrl()}
      locale={resolveEmojibaseLocale(i18n.language)}
      onEmojiSelect={(emoji) => onSelect(normalizeAgentRoleEmoji(emoji.emoji) ?? '')}
    >
      <EmojiPickerSearch />
      <EmojiPickerContent />
      <EmojiPickerFooter />
    </EmojiPicker>
  );
}

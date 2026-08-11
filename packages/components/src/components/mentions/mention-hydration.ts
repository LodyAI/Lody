import * as React from 'react';
import { useMentionContext } from '@/ui/mention';

export type HydratedMentions = {
  mentions: Array<{ value: string; start: number; end: number }>;
  values: string[];
};

/**
 * Restore the mention ranges a reloaded draft's text still implies.
 *
 * Mention ranges are not persisted with a draft, so after a reload only the
 * text survives and every source has to recognise its own tokens again. The
 * guards are identical for all of them — hydrate the *initial* text only, once,
 * and never while the menu is open — as is the merge rule, which has to keep
 * existing external `pasted_text` ranges intact. Both live here so a source only
 * supplies its `hydrate`.
 *
 * `hydrate` runs after the guards pass and may return `null` when its data has
 * not arrived yet; that leaves the hydrator armed for a later attempt. Pass a
 * stable callback — it is an effect dependency.
 */
export function useMentionHydration(
  consumerName: string,
  {
    text,
    enabled,
    hydrate,
  }: {
    text: string;
    enabled: boolean;
    hydrate: (text: string) => HydratedMentions | null;
  }
): void {
  const context = useMentionContext(consumerName);
  const initialTextRef = React.useRef(text);
  const hydratedRef = React.useRef(false);

  React.useEffect(() => {
    if (!enabled || hydratedRef.current) return;
    const initialText = initialTextRef.current;
    if (!initialText || text !== initialText || context.open) return;

    const hydrated = hydrate(initialText);
    if (!hydrated || hydrated.mentions.length === 0) return;

    hydratedRef.current = true;
    context.onMentionsChange((prev) => {
      const merged = [...prev, ...hydrated.mentions].sort((a, b) => a.start - b.start);
      const seen = new Set<string>();
      return merged.filter((mention) => {
        const key = `${mention.start}:${mention.end}:${mention.value}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    });
    context.onValueChange((prev) => Array.from(new Set([...(prev ?? []), ...hydrated.values])));
  }, [context, enabled, hydrate, text]);
}

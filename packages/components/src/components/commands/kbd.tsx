import { Kbd as KbdPrimitive, KbdGroup } from '@lody/ui/kbd';
import { formatKeyParts } from '@/lib/commands';

type KbdProps = {
  /** Binding string in registry syntax, e.g. `Mod+b`, `Shift+Enter`. */
  binding: string;
  className?: string;
};

/**
 * Display a key binding as a row of individual key chips, built on `@lody/ui`'s
 * `Kbd` / `KbdGroup`, so every surface that teaches a shortcut — the palette,
 * settings, a tooltip — draws the same cap. The package owns what a cap is made
 * of; this component owns only the split from a binding string into keys, which
 * is a fact about Lody's registry syntax rather than about keyboards.
 */
export function Kbd({ binding, className }: KbdProps) {
  const parts = formatKeyParts(binding);
  if (parts.length === 0) return null;
  return (
    <KbdGroup className={className}>
      {parts.map((label, i) => (
        <KbdPrimitive key={`${label}-${i}`}>{label}</KbdPrimitive>
      ))}
    </KbdGroup>
  );
}

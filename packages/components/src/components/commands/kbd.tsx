import { cn } from '@/lib/utils';
import { formatKeyParts } from '@/lib/commands';
import { Kbd as KbdPrimitive, KbdGroup } from '@/ui/kbd';

type KbdProps = {
  /** Binding string in registry syntax, e.g. `Mod+b`, `Shift+Enter`. */
  binding: string;
  className?: string;
};

/**
 * Display a key binding as a row of individual key chips. Built on the shadcn-style
 * `Kbd` / `KbdGroup` primitives in `@/ui/kbd` so it shares the platform-wide visual
 * language for keys (palette, settings, future tooltips, etc.).
 */
export function Kbd({ binding, className }: KbdProps) {
  const parts = formatKeyParts(binding);
  if (parts.length === 0) return null;
  return (
    <KbdGroup className={cn(className)}>
      {parts.map((label, i) => (
        <KbdPrimitive key={`${label}-${i}`}>{label}</KbdPrimitive>
      ))}
    </KbdGroup>
  );
}

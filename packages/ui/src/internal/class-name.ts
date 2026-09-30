/**
 * A Lody primitive computes its StyleX classes and appends whatever the caller
 * passed, so a caller class always lands after the compiled ones, the way it
 * does on `Button`.
 */
export function appendClassName(
  compiled: string | undefined,
  caller: string | undefined
): string | undefined {
  if (!caller) return compiled;
  return compiled ? `${compiled} ${caller}` : caller;
}
